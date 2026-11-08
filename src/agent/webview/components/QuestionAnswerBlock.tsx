import { useMemo, useState } from "preact/hooks";

import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import { StreamingText } from "./StreamingText";

type QuestionAnswerData = ContentBlock & { type: "question_answer" };

interface QuestionAnswerBlockProps {
  block: QuestionAnswerData;
  /** Raw `ask_user` tool input, used to show the original request on expand. */
  askUserInputJson?: string;
  onOpenFile?: (path: string, line?: number) => void;
}

interface OriginalQuestion {
  question: string;
  context?: string;
  options?: string[];
  recommended?: string;
}

interface OriginalRequest {
  context?: string;
  questions: OriginalQuestion[];
}

function formatAnswer(
  answer: string | string[] | number | boolean | null,
): string {
  if (answer === null || answer === undefined) return "—";
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (typeof answer === "number") return String(answer);
  if (Array.isArray(answer)) return answer.join(", ");
  return answer;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseAskUserOriginalRequest(
  inputJson: string | undefined,
): OriginalRequest | undefined {
  if (!inputJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const questions = Array.isArray(record.questions)
    ? record.questions.flatMap((entry): OriginalQuestion[] => {
        if (!entry || typeof entry !== "object") return [];
        const q = entry as Record<string, unknown>;
        const question = optionalText(q.question);
        if (!question) return [];
        const options = Array.isArray(q.options)
          ? q.options.filter(
              (option): option is string => typeof option === "string",
            )
          : [];
        return [
          {
            question,
            ...(optionalText(q.context)
              ? { context: optionalText(q.context) }
              : {}),
            ...(options.length > 0 ? { options } : {}),
            ...(optionalText(q.recommended)
              ? { recommended: optionalText(q.recommended) }
              : {}),
          },
        ];
      })
    : [];
  const context = optionalText(record.context);
  if (!context && questions.length === 0) return undefined;
  return { ...(context ? { context } : {}), questions };
}

/** Pair each answered item with its original question by text, then by position. */
function matchOriginalQuestion(
  original: OriginalRequest | undefined,
  question: string,
  index: number,
): OriginalQuestion | undefined {
  if (!original) return undefined;
  return (
    original.questions.find((q) => q.question === question.trim()) ??
    original.questions[index]
  );
}

function hasExtraDetail(
  original: OriginalRequest | undefined,
  items: QuestionAnswerData["items"],
): boolean {
  if (!original) return false;
  if (original.context) return true;
  return items.some((item, i) => {
    const match = matchOriginalQuestion(original, item.question, i);
    return Boolean(
      match &&
      (match.context ||
        match.options?.length ||
        match.question !== item.question.trim()),
    );
  });
}

export function QuestionAnswerBlock({
  block,
  askUserInputJson,
  onOpenFile,
}: QuestionAnswerBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const original = useMemo(
    () => parseAskUserOriginalRequest(askUserInputJson),
    [askUserInputJson],
  );
  const expandable = hasExtraDetail(original, block.items);

  return (
    <div class="qa-summary-block">
      <div class="qa-summary-header">
        <i class="codicon codicon-feedback" />
        <span>Your Answers</span>
        {expandable && (
          <button
            type="button"
            class="qa-summary-toggle"
            aria-expanded={expanded}
            title={
              expanded
                ? "Hide the original question"
                : "Show the original question"
            }
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{expanded ? "Hide original" : "Show original"}</span>
            <i class={`codicon codicon-chevron-${expanded ? "up" : "down"}`} />
          </button>
        )}
      </div>
      {expanded && original?.context && (
        <div class="qa-summary-original-context">
          <StreamingText
            text={original.context}
            streaming={false}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
      <div class="qa-summary-items">
        {block.items.map((item, i) => {
          const match = expanded
            ? matchOriginalQuestion(original, item.question, i)
            : undefined;
          return (
            <div key={i} class="qa-summary-item">
              {match ? (
                <div class="qa-summary-original">
                  {match.context && (
                    <div class="qa-summary-original-question-context">
                      <StreamingText
                        text={match.context}
                        streaming={false}
                        onOpenFile={onOpenFile}
                      />
                    </div>
                  )}
                  <div class="qa-summary-original-question">
                    <StreamingText
                      text={match.question}
                      streaming={false}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                  {match.options && match.options.length > 0 && (
                    <ul class="qa-summary-original-options">
                      {match.options.map((option) => (
                        <li key={option}>
                          {option}
                          {option === match.recommended && (
                            <span class="qa-summary-recommended">
                              {" "}
                              (recommended)
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div class="qa-summary-question">{item.question}</div>
              )}
              <div class="qa-summary-answer">{formatAnswer(item.answer)}</div>
              {item.note && (
                <div class="qa-summary-note">
                  <i class="codicon codicon-note" />
                  {item.note}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
