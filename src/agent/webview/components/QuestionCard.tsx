import type { ModeInfo, Question } from "../types";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { StreamingText } from "./StreamingText";

export interface QuestionProgress {
  step: number;
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
}

interface QuestionCardProps {
  id: string;
  context: string;
  questions: Question[];
  onSubmit: (
    id: string,
    answers: Record<string, string | string[] | number | boolean | undefined>,
    notes: Record<string, string>,
  ) => void;
  /** Remote-originated progress snapshot. Applied when its serialized shape differs from local. */
  remoteProgress?: QuestionProgress | null;
  /** Fires when the local user advances/edits state so the other surface can mirror. */
  onProgressChange?: (progress: QuestionProgress) => void;
  /** When set, the question is from a background agent with this task name. */
  backgroundTask?: string;
  /** Available agent modes — used to render the display name on modeSwitch badges. */
  modes?: ModeInfo[];
}

function getModeDisplayName(slug: string, modes?: ModeInfo[]): string {
  const m = modes?.find((mode) => mode.slug === slug);
  return m ? m.name : slug;
}

function serializeProgress(progress: QuestionProgress): string {
  const orderedAnswers = Object.keys(progress.answers)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = progress.answers[key];
      return acc;
    }, {});
  const orderedNotes = Object.keys(progress.notes)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      acc[key] = progress.notes[key];
      return acc;
    }, {});
  return JSON.stringify({
    step: progress.step,
    answers: orderedAnswers,
    notes: orderedNotes,
  });
}

export function isQuestionAnswered(
  question: Question,
  answer: string | string[] | number | boolean | undefined,
  note: string,
): boolean {
  const hasNote = note.trim() !== "";
  if (question.type === "text") {
    if (question.allowBlank) return true;
    return (typeof answer === "string" && answer.trim() !== "") || hasNote;
  }
  if (question.type === "confirmation") {
    return answer === "confirmed" || answer === "rejected";
  }
  if (question.type === "multiple_select") {
    return (Array.isArray(answer) && answer.length > 0) || hasNote;
  }
  return (answer !== undefined && answer !== null && answer !== "") || hasNote;
}

export function normalizeQuestionAnswer(
  question: Question,
  answers: Record<string, string | string[] | number | boolean | undefined>,
): Record<string, string | string[] | number | boolean | undefined> {
  if (
    question.type === "text" &&
    question.allowBlank &&
    !(question.id in answers)
  ) {
    return { ...answers, [question.id]: "" };
  }
  return answers;
}

export function QuestionCard({
  id,
  questions,
  onSubmit,
  remoteProgress,
  onProgressChange,
  backgroundTask,
  modes,
}: QuestionCardProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, string | string[] | number | boolean | undefined>
  >({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const lastAppliedRemoteRef = useRef<string | null>(null);
  const lastPublishedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!remoteProgress) return;
    const serialized = serializeProgress(remoteProgress);
    if (serialized === lastAppliedRemoteRef.current) return;
    if (serialized === serializeProgress({ step, answers, notes })) {
      lastAppliedRemoteRef.current = serialized;
      return;
    }
    lastAppliedRemoteRef.current = serialized;
    lastPublishedRef.current = serialized;
    setStep(remoteProgress.step);
    setAnswers({ ...remoteProgress.answers });
    setNotes({ ...remoteProgress.notes });
  }, [remoteProgress, step, answers, notes]);

  useEffect(() => {
    if (!onProgressChange) return;
    const snapshot: QuestionProgress = { step, answers, notes };
    const serialized = serializeProgress(snapshot);
    if (serialized === lastPublishedRef.current) return;
    lastPublishedRef.current = serialized;
    onProgressChange(snapshot);
  }, [step, answers, notes, onProgressChange]);

  const q = questions[step];
  const questionContext = q.context?.trim() ?? "";
  const isLast = step === questions.length - 1;
  const currentAnswer = answers[q.id];
  const currentNote = notes[q.id] ?? "";

  const isAnswered = useCallback(
    () => isQuestionAnswered(q, currentAnswer, currentNote),
    [q, currentAnswer, currentNote],
  );

  const setAnswer = useCallback(
    (value: string | string[] | number | boolean | undefined) => {
      setAnswers((prev) => {
        if (value === undefined) {
          const next = { ...prev };
          delete next[q.id];
          return next;
        }
        return { ...prev, [q.id]: value };
      });
    },
    [q.id],
  );

  const setNote = useCallback(
    (text: string) => {
      setNotes((prev) => ({ ...prev, [q.id]: text }));
    },
    [q.id],
  );

  const handleNext = useCallback(() => {
    if (!isAnswered()) return;
    setAnswers((prev) => normalizeQuestionAnswer(q, prev));
    setStep((s) => s + 1);
  }, [isAnswered, q]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!isAnswered()) return;
    onSubmit(id, normalizeQuestionAnswer(q, answers), notes);
  }, [id, q, answers, notes, isAnswered, onSubmit]);

  const handleConfirmationPrimary = useCallback(() => {
    if (q.type !== "confirmation") return;

    if (currentAnswer === "confirmed") {
      if (isLast) {
        onSubmit(id, answers, notes);
      } else {
        setStep((s) => s + 1);
      }
      return;
    }

    const nextAnswers = { ...answers, [q.id]: "rejected" as const };
    if (isLast) {
      onSubmit(id, nextAnswers, notes);
    } else {
      setAnswers(nextAnswers);
      setStep((s) => s + 1);
    }
  }, [q.type, q.id, currentAnswer, isLast, id, answers, notes, onSubmit]);

  const showNoteInput = true;

  return (
    <div class="question-card">
      {backgroundTask && (
        <div class="question-bg-attribution">
          From background agent: <strong>{backgroundTask}</strong>
        </div>
      )}
      <div class="question-body">
        {questionContext && (
          <QuestionMarkdown
            className="question-context"
            text={questionContext}
          />
        )}

        {questions.length > 1 && (
          <div class="question-progress">
            {questions.map((_, i) => (
              <span
                key={i}
                class={`question-dot${i === step ? " question-dot-active" : i < step ? " question-dot-done" : ""}`}
              />
            ))}
            <span class="question-progress-label">
              {step + 1} / {questions.length}
            </span>
          </div>
        )}

        <QuestionMarkdown className="question-text" text={q.question} />

        <QuestionInput
          question={q}
          value={currentAnswer}
          onChange={setAnswer}
          modes={modes}
        />

        {showNoteInput && (
          <textarea
            class="question-other-input"
            placeholder="Other / add context (optional)"
            value={currentNote}
            onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
            rows={2}
          />
        )}
      </div>

      <div class="question-nav">
        <button
          class="question-nav-btn"
          onClick={handleBack}
          disabled={step === 0}
        >
          Back
        </button>
        {q.type === "confirmation" ? (
          <button
            class={
              isLast || currentAnswer !== "confirmed"
                ? "question-submit"
                : "question-nav-btn question-nav-next"
            }
            onClick={handleConfirmationPrimary}
          >
            {currentAnswer === "confirmed"
              ? isLast
                ? "Submit"
                : "Next"
              : "Reject"}
          </button>
        ) : isLast ? (
          <button
            class="question-submit"
            disabled={!isAnswered()}
            onClick={handleSubmit}
          >
            Submit
          </button>
        ) : (
          <button
            class="question-nav-btn question-nav-next"
            disabled={!isAnswered()}
            onClick={handleNext}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionMarkdown({
  className,
  text,
}: {
  className: string;
  text: string;
}) {
  return (
    <div class={className}>
      <StreamingText text={text} streaming={false} />
    </div>
  );
}

interface QuestionInputProps {
  question: Question;
  value: string | string[] | number | boolean | undefined;
  onChange: (v: string | string[] | number | boolean | undefined) => void;
  modes?: ModeInfo[];
}

function QuestionInput({
  question,
  value,
  onChange,
  modes,
}: QuestionInputProps) {
  const { type, options = [], scale_min = 1, scale_max = 5 } = question;

  if (type === "text") {
    return (
      <textarea
        class="question-text-input"
        value={(value as string) ?? ""}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        rows={3}
        placeholder="Type your answer..."
        autoFocus
      />
    );
  }

  if (type === "confirmation") {
    return (
      <button
        class={`question-option${value === "confirmed" ? " selected" : ""}`}
        onClick={() =>
          onChange(value === "confirmed" ? undefined : "confirmed")
        }
      >
        Got it
      </button>
    );
  }

  if (type === "yes_no") {
    return (
      <div class="question-options">
        {(["Yes", "No"] as const).map((label) => {
          const val = label === "Yes";
          const sel = value === val;
          return (
            <button
              key={label}
              class={`question-option${sel ? " selected" : ""}`}
              onClick={() => onChange(sel ? undefined : val)}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  }

  if (type === "scale") {
    const nums = Array.from(
      { length: scale_max - scale_min + 1 },
      (_, i) => scale_min + i,
    );
    const hasLabels = question.scale_min_label || question.scale_max_label;
    return (
      <div class="question-scale">
        <div class="scale-options">
          {nums.map((n) => (
            <button
              key={n}
              class={`question-option scale-option${value === n ? " selected" : ""}`}
              onClick={() => onChange(value === n ? undefined : n)}
            >
              {n}
            </button>
          ))}
        </div>
        {hasLabels && (
          <div class="scale-labels-row">
            <span class="scale-label scale-label-min">
              {question.scale_min_label ?? ""}
            </span>
            <span class="scale-label scale-label-max">
              {question.scale_max_label ?? ""}
            </span>
          </div>
        )}
      </div>
    );
  }

  // multiple_choice or multiple_select
  const isMulti = type === "multiple_select";

  const isSelected = (opt: string) => {
    if (isMulti)
      return Array.isArray(value) && (value as string[]).includes(opt);
    return value === opt;
  };

  const toggle = (opt: string) => {
    if (!isMulti) {
      onChange(isSelected(opt) ? undefined : opt);
    } else {
      const cur = Array.isArray(value) ? (value as string[]) : [];
      onChange(
        cur.includes(opt) ? cur.filter((v) => v !== opt) : [...cur, opt],
      );
    }
  };

  return (
    <div class="question-options">
      {options.map((opt) => {
        const targetMode =
          !isMulti && question.modeSwitch
            ? question.modeSwitch[opt]
            : undefined;
        return (
          <button
            key={opt}
            class={`question-option${isSelected(opt) ? " selected" : ""}`}
            onClick={() => toggle(opt)}
          >
            {isMulti && (
              <span
                class={`q-checkbox${isSelected(opt) ? " q-checkbox-checked" : ""}`}
              />
            )}
            {opt}
            {question.recommended === opt && (
              <span class="question-recommended-badge">Recommended</span>
            )}
            {targetMode && (
              <span class="question-mode-badge">
                → {getModeDisplayName(targetMode, modes)} mode
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
