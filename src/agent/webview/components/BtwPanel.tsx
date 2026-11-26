import type { BtwBudget, BtwExchange } from "../types";
import { mountMarkdownImages, unmountMarkdownImages } from "./StreamingText";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import DOMPurify from "dompurify";
import { Marked } from "marked";
import { renderMarkdownImagePlaceholder } from "./markdownImagePlaceholder";
import { renderMarkdownTaskCheckbox } from "./markdownTaskCheckbox";
import { useMarkdownImageHost } from "./MarkdownImage";

export interface BtwState {
  requestId: string;
  /** Completed earlier exchanges in this side thread. */
  history?: BtwExchange[];
  question: string;
  answer: string;
  error?: boolean;
  /** True once the final response has arrived (streaming complete). */
  done?: boolean;
  /** True when the run was cut short by cancellation or the deadline. */
  cancelled?: boolean;
  /** Tool names invoked so far, in order. */
  tools?: string[];
  /** Warnings surfaced so far (retries, timeouts, limit notices). */
  warnings?: string[];
  budget?: BtwBudget;
}

interface BtwPanelProps {
  state: BtwState;
  onDismiss: () => void;
  onCancel: (requestId: string) => void;
  /** Ask a follow-up inside the side thread. */
  onFollowUp: (question: string, history: BtwExchange[]) => void;
  /** Send the thread plus the user's follow-up to the main chat. */
  onSendToChat: (followUp: string, thread: BtwExchange[]) => void;
}

/** Completed exchanges in the thread, including the current one when done. */
export function getBtwThread(state: BtwState): BtwExchange[] {
  const thread = [...(state.history ?? [])];
  if (state.done && !state.error && state.answer.trim()) {
    thread.push({ question: state.question, answer: state.answer });
  }
  return thread;
}

export { buildBtwChatMessage } from "../../../shared/btwThread";

function renderMarkdown(text: string): string {
  const localMarked = new Marked({
    renderer: {
      html({ text }: { text: string }) {
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      },
      code({ text, lang }: { text: string; lang?: string }) {
        const langClass = lang ? ` class="language-${lang}"` : "";
        return `<pre><code${langClass}>${text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</code></pre>`;
      },
      checkbox({ checked }: { checked: boolean }) {
        return renderMarkdownTaskCheckbox(checked);
      },
      image: renderMarkdownImagePlaceholder,
    },
  });

  const raw = localMarked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:https?|vscode):/i,
  });
}

export function BtwPanel({
  state,
  onDismiss,
  onCancel,
  onFollowUp,
  onSendToChat,
}: BtwPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const imageHost = useMarkdownImageHost();
  const [draft, setDraft] = useState("");
  const isStreaming = !state.done && !state.error;
  const isThinking = isStreaming && !state.answer;
  const thread = getBtwThread(state);
  const canFollowUp = !isStreaming && Boolean(draft.trim());
  const canSendToChat = !isStreaming && thread.length > 0;

  const html = useMemo(
    () => (state.answer ? renderMarkdown(state.answer) : ""),
    [state.answer],
  );
  const historyHtml = useMemo(
    () =>
      (state.history ?? []).map((exchange) => renderMarkdown(exchange.answer)),
    [state.history],
  );

  useEffect(() => {
    if (!markdownRef.current) return;
    const slots = mountMarkdownImages(markdownRef.current, imageHost);
    return () => unmountMarkdownImages(slots);
  }, [html, imageHost]);

  const submitFollowUp = () => {
    const question = draft.trim();
    if (!question || isStreaming) return;
    onFollowUp(question, thread);
    setDraft("");
  };

  const submitToChat = () => {
    if (!canSendToChat) return;
    onSendToChat(draft, thread);
    setDraft("");
  };

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  // Scroll to bottom when content changes
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [html]);

  const budget = state.budget;
  const lastTool = state.tools?.[state.tools.length - 1];

  return (
    <div class="btw-panel">
      <div class="btw-header">
        <i class="codicon codicon-comment-discussion" />
        <span class="btw-question">{state.question}</span>
        {budget && (budget.apiTurns > 0 || budget.toolCalls > 0) && (
          <span
            class="btw-budget"
            title="API turns and tool calls used of the /btw budget"
          >
            {budget.apiTurns}/{budget.maxApiTurns} turns · {budget.toolCalls}/
            {budget.maxToolCalls} tools
          </span>
        )}
        {isStreaming && (
          <button
            class="icon-button btw-cancel"
            onClick={() => onCancel(state.requestId)}
            title="Cancel"
          >
            <i class="codicon codicon-stop-circle" />
          </button>
        )}
        <button
          class="icon-button btw-close"
          onClick={onDismiss}
          title="Dismiss (Esc)"
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      <div
        class={`btw-body${state.error ? " btw-error" : ""}`}
        ref={contentRef}
      >
        {(state.history ?? []).map((exchange, index) => (
          <div class="btw-exchange" key={`${index}:${exchange.question}`}>
            <div class="btw-exchange-question">{exchange.question}</div>
            <div
              class="markdown-body"
              dangerouslySetInnerHTML={{ __html: historyHtml[index] ?? "" }}
            />
          </div>
        ))}
        {(state.history?.length ?? 0) > 0 && (
          <div class="btw-exchange-question">{state.question}</div>
        )}
        {state.answer && (
          <div
            ref={markdownRef}
            class="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {isThinking && (
          <div class="btw-loading">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>{lastTool ? `Running ${lastTool}…` : "Thinking…"}</span>
          </div>
        )}
        {state.cancelled && !state.error && (
          <div class="btw-notice">Stopped before completing.</div>
        )}
      </div>
      <div class="btw-reply">
        <textarea
          class="btw-input"
          rows={1}
          value={draft}
          placeholder={
            isStreaming
              ? "Type a follow-up or a note for the main chat…"
              : "Ask a follow-up (Enter) or send to chat (⌘/Ctrl+Enter)…"
          }
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.metaKey || e.ctrlKey) submitToChat();
            else submitFollowUp();
          }}
        />
      </div>
      <div class="btw-footer">
        {(state.warnings?.length ?? 0) > 0 && (
          <span class="btw-warnings" title={state.warnings?.join("\n")}>
            <i class="codicon codicon-warning" /> {state.warnings?.length}
          </span>
        )}
        <div class="btw-actions">
          <button
            class="btw-secondary"
            disabled={!canFollowUp}
            onClick={submitFollowUp}
            title="Ask a follow-up in this side thread (Enter)"
          >
            <i class="codicon codicon-comment-discussion" /> Ask
          </button>
          <button
            class="btw-promote"
            disabled={!canSendToChat}
            onClick={submitToChat}
            title="Send this side thread and your message to the main chat (⌘/Ctrl+Enter). Queued if the agent is busy."
          >
            <i class="codicon codicon-send" /> Send to chat
          </button>
        </div>
      </div>
    </div>
  );
}
