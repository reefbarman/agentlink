import "./background-coordination.css";

import type { BackgroundCoordination } from "@agentlink/protocol/chat-transcript";
import type { BackgroundCoordinationReply } from "../../../shared/backgroundCoordination";

function readableAnswer(value: unknown): string {
  if (value === null) return "No answer";
  if (Array.isArray(value)) return value.map(readableAnswer).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function BackgroundCoordinationCard({
  request,
  reply,
}: {
  request: BackgroundCoordination;
  reply?: BackgroundCoordinationReply;
}) {
  const status = reply?.status ?? "waiting";
  const statusLabel = {
    waiting: "Waiting for reply",
    responding: "Responding",
    answered: "Answered",
    failed: "Response failed",
  }[status];
  const answerIds = reply
    ? [...new Set([...Object.keys(reply.answers), ...Object.keys(reply.notes)])]
    : [];

  return (
    <details
      class={`background-coordination background-coordination-${status}`}
      data-request-id={request.requestId}
    >
      <summary class="background-coordination-summary">
        <i
          class="codicon codicon-arrow-swap background-coordination-icon"
          aria-hidden="true"
        />
        <span class="background-coordination-heading">
          <span class="background-coordination-title">Agent communication</span>
          <span class="background-coordination-task">{request.task}</span>
          <span class="background-coordination-meta">
            <span class="background-coordination-kind">
              {request.kind === "approval" ? "Approval" : "Question"}
            </span>
            <span class="background-coordination-status" role="status">
              {statusLabel}
            </span>
          </span>
        </span>
        <i
          class="codicon codicon-chevron-right background-coordination-chevron"
          aria-hidden="true"
        />
      </summary>
      <div class="background-coordination-body">
        <section aria-label="Background request">
          <h4>Background → Foreground</h4>
          {request.context && <p>{request.context}</p>}
          {request.questions.map((question) => (
            <div class="background-coordination-question" key={question.id}>
              <strong>{question.question}</strong>
              {question.context && <p>{question.context}</p>}
              {question.options && question.options.length > 0 && (
                <ul>
                  {question.options.map((option, index) => (
                    <li key={index}>{option}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
        {reply && (
          <section aria-label="Foreground response">
            <h4>Foreground → Background</h4>
            {status !== "answered" && (
              <p>
                {status === "responding"
                  ? "Sending reply…"
                  : "Reply was not accepted. See the tool result for details."}
              </p>
            )}
            <dl>
              {answerIds.map((id) => (
                <div key={id}>
                  <dt>
                    {request.questions.find((question) => question.id === id)
                      ?.question ?? id}
                  </dt>
                  {Object.hasOwn(reply.answers, id) && (
                    <dd>{readableAnswer(reply.answers[id])}</dd>
                  )}
                  {Object.hasOwn(reply.notes, id) && (
                    <dd class="background-coordination-note">
                      Note: {readableAnswer(reply.notes[id])}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </details>
  );
}
