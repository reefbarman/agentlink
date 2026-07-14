import { useEffect, useRef, useMemo } from "preact/hooks";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import type { BtwBudget } from "../types";
import { renderMarkdownTaskCheckbox } from "./markdownTaskCheckbox";

export interface BtwState {
  requestId: string;
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
  onPromote: (question: string, answer: string) => void;
}

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
  onPromote,
}: BtwPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isStreaming = !state.done && !state.error;
  const isThinking = isStreaming && !state.answer;
  const canPromote = Boolean(state.done && !state.error && state.answer);

  const html = useMemo(
    () => (state.answer ? renderMarkdown(state.answer) : ""),
    [state.answer],
  );

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
        {state.answer && (
          <div
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
      {(canPromote || (state.warnings?.length ?? 0) > 0) && (
        <div class="btw-footer">
          {(state.warnings?.length ?? 0) > 0 && (
            <span class="btw-warnings" title={state.warnings?.join("\n")}>
              <i class="codicon codicon-warning" /> {state.warnings?.length}
            </span>
          )}
          {canPromote && (
            <button
              class="btw-promote"
              onClick={() => onPromote(state.question, state.answer)}
              title="Add this question and answer to the main conversation"
            >
              <i class="codicon codicon-add" /> Add to conversation
            </button>
          )}
        </div>
      )}
    </div>
  );
}
