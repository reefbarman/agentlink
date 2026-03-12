import type { ContentBlock } from "../types";

type QuestionAnswerData = ContentBlock & { type: "question_answer" };

interface QuestionAnswerBlockProps {
  block: QuestionAnswerData;
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

export function QuestionAnswerBlock({ block }: QuestionAnswerBlockProps) {
  return (
    <div class="qa-summary-block">
      <div class="qa-summary-header">
        <i class="codicon codicon-feedback" />
        <span>Your Answers</span>
      </div>
      <div class="qa-summary-items">
        {block.items.map((item, i) => (
          <div key={i} class="qa-summary-item">
            <div class="qa-summary-question">{item.question}</div>
            <div class="qa-summary-answer">{formatAnswer(item.answer)}</div>
            {item.note && (
              <div class="qa-summary-note">
                <i class="codicon codicon-note" />
                {item.note}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
