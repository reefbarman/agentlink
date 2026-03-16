import { useEffect, useRef, useMemo } from "preact/hooks";
import { Marked } from "marked";
import DOMPurify from "dompurify";

export interface BtwState {
  requestId: string;
  question: string;
  answer: string;
  error?: boolean;
}

interface BtwPanelProps {
  state: BtwState;
  onDismiss: () => void;
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
    },
  });

  const raw = localMarked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:https?|vscode):/i,
  });
}

export function BtwPanel({ state, onDismiss }: BtwPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isLoading = !state.answer && !state.error;

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

  return (
    <div class="btw-panel">
      <div class="btw-header">
        <i class="codicon codicon-comment-discussion" />
        <span class="btw-question">{state.question}</span>
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
        {isLoading ? (
          <div class="btw-loading">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>Thinking…</span>
          </div>
        ) : (
          <div
            class="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
}
