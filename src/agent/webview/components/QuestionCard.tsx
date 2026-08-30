import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { ChatModeInfo as ModeInfo } from "@agentlink/protocol/chat-catalog";
import type { UserQuestion as Question } from "@agentlink/protocol/structured-question";
import { StreamingText } from "./StreamingText";
import { getConfirmationOptions } from "@agentlink/protocol/question-confirmation";

export interface QuestionProgress {
  step: number;
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
}

export interface QuestionAttachmentDraft {
  questionId: string;
  paths: string[];
  media: Array<{
    name: string;
    mimeType: string;
    base64: string;
    kind: "image" | "document";
  }>;
}

export interface QuestionOtherContext {
  questionId: string;
  initialText: string;
  onCommit: (text: string) => void;
}

export interface QuestionComposerState extends QuestionOtherContext {
  revision: string;
  focusComposer: boolean;
  canGoBack: boolean;
  onBack: (text: string, attachments: QuestionAttachmentDraft) => void;
  primaryLabel: "Next" | "Submit";
  primaryDisabled: boolean;
  onPrimary: (text: string, attachments: QuestionAttachmentDraft) => void;
  hidePrimaryAction?: boolean;
}

interface QuestionCardProps {
  id: string;
  context: string;
  questions: Question[];
  onSubmit: (
    id: string,
    answers: Record<string, string | string[] | number | boolean | undefined>,
    notes: Record<string, string>,
    currentAttachments?: QuestionAttachmentDraft,
  ) => void;
  onEditOtherContext?: (context: QuestionOtherContext) => void;
  /** Moves supplemental context and navigation into the replacement composer. */
  integratedComposer?: boolean;
  onComposerStateChange?: (state: QuestionComposerState) => void;
  attachmentCounts?: Record<string, number>;
  /** Remote-originated progress snapshot. Applied when its serialized shape differs from local. */
  remoteProgress?: QuestionProgress | null;
  /** Fires when the local user advances/edits state so the other surface can mirror. */
  onProgressChange?: (progress: QuestionProgress) => void;
  /** When set, the question is from a background agent with this task name. */
  backgroundTask?: string;
  /** Available agent modes — used to render the display name on modeSwitch badges. */
  modes?: ModeInfo[];
  /** Opens a workspace file referenced in question markdown. */
  onOpenFile?: (path: string, line?: number) => void;
}

function getModeDisplayName(slug: string, modes?: ModeInfo[]): string {
  const m = modes?.find((mode) => mode.slug === slug);
  return m ? m.name : slug;
}

function isRecommendedOption(question: Question, option: string): boolean {
  return question.recommended?.trim() === option.trim();
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
    return typeof answer === "string" && answer.trim() !== "";
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
  onEditOtherContext,
  integratedComposer = false,
  onComposerStateChange,
  attachmentCounts = {},
  onOpenFile,
}: QuestionCardProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, string | string[] | number | boolean | undefined>
  >({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const notesRef = useRef(notes);
  const lastAppliedRemoteRef = useRef<string | null>(null);
  const lastPublishedRef = useRef<string | null>(null);
  const hasLocalProgressEditRef = useRef(false);

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
    notesRef.current = { ...remoteProgress.notes };
    setNotes(notesRef.current);
  }, [remoteProgress, step, answers, notes]);

  useEffect(() => {
    if (!onProgressChange || !hasLocalProgressEditRef.current) return;
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
  const attachmentCount = attachmentCounts[q.id] ?? 0;

  const isAnswered = useCallback(
    () =>
      attachmentCount > 0 || isQuestionAnswered(q, currentAnswer, currentNote),
    [q, currentAnswer, currentNote, attachmentCount],
  );

  const setAnswer = useCallback(
    (value: string | string[] | number | boolean | undefined) => {
      hasLocalProgressEditRef.current = true;
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
      hasLocalProgressEditRef.current = true;
      notesRef.current = { ...notesRef.current, [q.id]: text };
      setNotes(notesRef.current);
    },
    [q.id],
  );

  const handleNext = useCallback(() => {
    if (!isAnswered()) return;
    hasLocalProgressEditRef.current = true;
    setAnswers((prev) => normalizeQuestionAnswer(q, prev));
    setStep((s) => s + 1);
  }, [isAnswered, q]);

  const handleBack = useCallback(() => {
    hasLocalProgressEditRef.current = true;
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!isAnswered()) return;
    onSubmit(id, normalizeQuestionAnswer(q, answers), notes);
  }, [id, q, answers, notes, isAnswered, onSubmit]);

  const handleComposerBack = useCallback(
    (_text: string, _attachments: QuestionAttachmentDraft) => {
      hasLocalProgressEditRef.current = true;
      setStep((currentStep) => Math.max(0, currentStep - 1));
    },
    [q.id],
  );

  const handleComposerPrimary = useCallback(
    (text: string, attachments: QuestionAttachmentDraft) => {
      const nextNotes = { ...notes, [q.id]: text };
      const hasContext =
        text.trim() !== "" ||
        attachments.paths.length > 0 ||
        attachments.media.length > 0;
      const answered = hasContext || isQuestionAnswered(q, currentAnswer, text);

      if (!answered) return;
      const nextAnswers = normalizeQuestionAnswer(q, answers);
      if (isLast) {
        onSubmit(id, nextAnswers, nextNotes, attachments);
      } else {
        hasLocalProgressEditRef.current = true;
        setAnswers(nextAnswers);
        setNotes(nextNotes);
        setStep((currentStep) => currentStep + 1);
      }
    },
    [q, currentAnswer, notes, answers, isLast, id, onSubmit],
  );

  const handleConfirmation = useCallback(
    (answer: string) => {
      if (q.type !== "confirmation") return;
      const nextAnswers = { ...answers, [q.id]: answer };
      if (isLast) {
        onSubmit(id, nextAnswers, notesRef.current);
      } else {
        hasLocalProgressEditRef.current = true;
        setAnswers(nextAnswers);
        setStep((s) => s + 1);
      }
    },
    [q.type, q.id, isLast, id, answers, onSubmit],
  );

  useEffect(() => {
    if (!integratedComposer || !onComposerStateChange) return;
    const primaryLabel = isLast ? "Submit" : "Next";
    onComposerStateChange({
      revision: JSON.stringify({ step, answers, notes }),
      questionId: q.id,
      initialText: currentNote,
      focusComposer: q.type !== "text" && q.type !== "confirmation",
      onCommit: setNote,
      canGoBack: step > 0,
      onBack: handleComposerBack,
      primaryLabel,
      primaryDisabled: !isAnswered(),
      onPrimary: handleComposerPrimary,
      hidePrimaryAction: q.type === "confirmation",
    });
  }, [
    integratedComposer,
    onComposerStateChange,
    q,
    currentAnswer,
    currentNote,
    answers,
    notes,
    isLast,
    step,
    setNote,
    handleComposerBack,
    isAnswered,
    handleComposerPrimary,
  ]);

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
            onOpenFile={onOpenFile}
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

        <QuestionMarkdown
          className="question-text"
          text={q.question}
          onOpenFile={onOpenFile}
        />

        <QuestionInput
          question={q}
          value={currentAnswer}
          onChange={setAnswer}
          onConfirm={handleConfirmation}
          modes={modes}
        />

        {!integratedComposer &&
          (onEditOtherContext ? (
            <div class="question-other-context">
              <button
                type="button"
                class={`question-other-action${currentNote.trim() || attachmentCount > 0 ? " has-context" : ""}`}
                onClick={() =>
                  onEditOtherContext({
                    questionId: q.id,
                    initialText: currentNote,
                    onCommit: setNote,
                  })
                }
              >
                <i class="codicon codicon-attach" aria-hidden="true" />
                <span>
                  {currentNote.trim() || attachmentCount > 0
                    ? "Edit other context"
                    : "Other / attach context…"}
                </span>
                {attachmentCount > 0 && (
                  <span class="question-other-count">
                    {attachmentCount}{" "}
                    {attachmentCount === 1 ? "attachment" : "attachments"}
                  </span>
                )}
              </button>
              {currentNote.trim() && (
                <div class="question-other-preview">
                  <div class="question-other-preview-label">Other context</div>
                  <div class="question-other-preview-text">
                    {currentNote.trim()}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <textarea
              class="question-other-input"
              placeholder="Other / add context (optional)"
              value={currentNote}
              onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)}
              rows={2}
            />
          ))}
      </div>

      {!integratedComposer && (q.type !== "confirmation" || step > 0) && (
        <div class="question-nav">
          <button
            class="question-nav-btn"
            onClick={handleBack}
            disabled={step === 0}
          >
            Back
          </button>
          {q.type !== "confirmation" &&
            (isLast ? (
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
            ))}
        </div>
      )}
    </div>
  );
}

function QuestionMarkdown({
  className,
  text,
  onOpenFile,
}: {
  className: string;
  text: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  return (
    <div class={className}>
      <StreamingText text={text} streaming={false} onOpenFile={onOpenFile} />
    </div>
  );
}

interface QuestionInputProps {
  question: Question;
  value: string | string[] | number | boolean | undefined;
  onChange: (v: string | string[] | number | boolean | undefined) => void;
  onConfirm: (answer: string) => void;
  modes?: ModeInfo[];
}

function QuestionInput({
  question,
  value,
  onChange,
  onConfirm,
  modes,
}: QuestionInputProps) {
  const { type, options = [], scale_min = 1, scale_max = 5 } = question;
  const confirmationOptionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (type !== "confirmation") return;
    confirmationOptionsRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
  }, [type, question.id]);

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
      <div ref={confirmationOptionsRef} class="question-options">
        {getConfirmationOptions(question.options).map((option) => (
          <button
            key={option}
            class={`question-option${value === option ? " selected" : ""}`}
            onClick={() => onConfirm(option)}
          >
            {option}
            {isRecommendedOption(question, option) && (
              <span class="question-recommended-badge">Recommended</span>
            )}
          </button>
        ))}
      </div>
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
              {isRecommendedOption(question, label) && (
                <span class="question-recommended-badge">Recommended</span>
              )}
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
              class={`question-option scale-option${value === n ? " selected" : ""}${isRecommendedOption(question, String(n)) ? " recommended" : ""}`}
              onClick={() => onChange(value === n ? undefined : n)}
            >
              {n}
            </button>
          ))}
        </div>
        {nums.some((n) => isRecommendedOption(question, String(n))) && (
          <div class="scale-recommendation">
            <span class="question-recommended-badge">
              Recommended: {question.recommended}
            </span>
          </div>
        )}
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
            {isRecommendedOption(question, opt) && (
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
