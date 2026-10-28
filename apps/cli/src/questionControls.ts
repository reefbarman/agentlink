import type {
  PresentTuiControl,
  TuiControlOption,
  TuiControlRequest,
} from "./tui/controlTypes.js";
import type {
  UserQuestion,
  UserQuestionAnswer,
} from "@agentlink/protocol/structured-question";
import type {
  WorkspaceQuestionsRequest,
  WorkspaceQuestionsResponse,
} from "@agentlink/workspace-host";

import { getConfirmationOptions } from "@agentlink/protocol/question-confirmation";

/** Scales with more steps than this are answered by typing a number. */
const MAX_SCALE_OPTIONS = 11;
const NOTE_INPUT = { placeholder: "Optional note" } as const;

/**
 * Ask VS Code's `ask_user` questions in the control panel, one at a time.
 * Every question type is supported; confirmation and multiple-select
 * questions take no note. Cancelling any question cancels the whole call.
 */
export async function askQuestionsInControlPanel(
  request: WorkspaceQuestionsRequest,
  presentControl: PresentTuiControl,
  signal?: AbortSignal,
): Promise<WorkspaceQuestionsResponse> {
  const answers: Record<string, UserQuestionAnswer> = {};
  const notes: Record<string, string> = {};
  const total = request.questions.length;
  for (const [index, question] of request.questions.entries()) {
    let problem: string | undefined;
    for (;;) {
      const control = questionControl(request, question, index, total, problem);
      const response = await presentControl(control, signal);
      if (response.cancelled || signal?.aborted) {
        throw abortError("Question cancelled by user");
      }
      const read = readAnswer(question, response);
      if ("problem" in read) {
        problem = read.problem;
        continue;
      }
      answers[question.id] = read.answer;
      const note = read.allowsNote ? response.text?.trim() : undefined;
      if (note) notes[question.id] = note;
      break;
    }
  }
  return { answers, notes };
}

function questionControl(
  request: WorkspaceQuestionsRequest,
  question: UserQuestion,
  index: number,
  total: number,
  problem: string | undefined,
): TuiControlRequest {
  const body = [
    ...(request.context ? [request.context] : []),
    ...(question.context ? [question.context] : []),
    ...(problem ? [problem] : []),
    // Last, because the activity shelf shows the final body line.
    question.question,
  ];
  const base = {
    id: `ask-user:${question.id}`,
    kind: "question" as const,
    title:
      total > 1 ? `Agent question ${index + 1} of ${total}` : "Agent question",
    body,
    cancellable: true,
  };
  const choice = (labels: readonly string[], ids = labels) => {
    const options: TuiControlOption[] = labels.map((label, position) => {
      // As VS Code's card shows, an answer mapped to a mode also switches.
      const mode = question.modeSwitch?.[label];
      const details = [
        ...(label === question.recommended ? ["recommended"] : []),
        ...(mode ? [`switches to ${mode} mode`] : []),
      ];
      return {
        id: ids[position]!,
        label,
        ...(details.length ? { detail: details.join(", ") } : {}),
      };
    });
    const recommended = options.find(
      (option) => option.label === question.recommended,
    );
    return {
      options,
      ...(recommended ? { initialOptionId: recommended.id } : {}),
    };
  };
  switch (question.type) {
    case "confirmation":
      return { ...base, ...choice(confirmationLabels(question)) };
    case "yes_no":
      return {
        ...base,
        ...choice(["Yes", "No"], ["yes", "no"]),
        input: NOTE_INPUT,
      };
    case "multiple_choice":
      return question.options?.length
        ? { ...base, ...choice(question.options), input: NOTE_INPUT }
        : { ...base, input: { placeholder: "Type your answer" } };
    case "multiple_select":
      return question.options?.length
        ? { ...base, ...choice(question.options), multiSelect: true }
        : { ...base, input: { placeholder: "Type your answer" } };
    case "scale": {
      const { min, max } = scaleRange(question);
      const labels = scaleLabels(question);
      if (
        Number.isInteger(min) &&
        Number.isInteger(max) &&
        max - min < MAX_SCALE_OPTIONS
      ) {
        const values = Array.from({ length: max - min + 1 }, (_, i) =>
          String(min + i),
        );
        const options = values.map((value) => ({
          id: value,
          label: value,
          ...(value === question.recommended
            ? { detail: "recommended" }
            : value === String(min) && labels.min
              ? { detail: labels.min }
              : value === String(max) && labels.max
                ? { detail: labels.max }
                : {}),
        }));
        return {
          ...base,
          options,
          ...(question.recommended && values.includes(question.recommended)
            ? { initialOptionId: question.recommended }
            : {}),
          input: NOTE_INPUT,
        };
      }
      return {
        ...base,
        body: [
          ...body.slice(0, -1),
          `Enter a number from ${min} to ${max}${labels.min || labels.max ? ` (${labels.min ?? min} to ${labels.max ?? max})` : ""}.`,
          question.question,
        ],
        input: { placeholder: question.recommended ?? `${min}-${max}` },
      };
    }
    case "text":
    default:
      return {
        ...base,
        input: {
          placeholder: question.allowBlank
            ? "Type your answer (optional)"
            : "Type your answer",
        },
      };
  }
}

type ReadAnswer =
  | { readonly answer: UserQuestionAnswer; readonly allowsNote: boolean }
  | { readonly problem: string };

function readAnswer(
  question: UserQuestion,
  response: Extract<
    Awaited<ReturnType<PresentTuiControl>>,
    { cancelled: false }
  >,
): ReadAnswer {
  const text = response.text ?? "";
  switch (question.type) {
    case "confirmation":
      return { answer: response.optionId, allowsNote: false };
    case "yes_no":
      return { answer: response.optionId === "yes", allowsNote: true };
    case "multiple_choice":
      return question.options?.length
        ? { answer: response.optionId, allowsNote: true }
        : requiredText(text);
    case "multiple_select":
      return question.options?.length
        ? { answer: [...(response.optionIds ?? [])], allowsNote: false }
        : requiredText(text);
    case "scale": {
      if (response.optionId !== undefined) {
        return { answer: Number(response.optionId), allowsNote: true };
      }
      const { min, max } = scaleRange(question);
      const value = Number(text.trim());
      if (
        !text.trim() ||
        !Number.isFinite(value) ||
        value < min ||
        value > max
      ) {
        return { problem: `Enter a number from ${min} to ${max}.` };
      }
      return { answer: value, allowsNote: false };
    }
    case "text":
    default:
      return question.allowBlank
        ? { answer: text, allowsNote: false }
        : requiredText(text);
  }
}

function requiredText(text: string): ReadAnswer {
  return text.trim()
    ? { answer: text, allowsNote: false }
    : { problem: "An answer is required." };
}

function confirmationLabels(question: UserQuestion): readonly string[] {
  return getConfirmationOptions(question.options);
}

function scaleRange(question: UserQuestion): { min: number; max: number } {
  return { min: question.scale_min ?? 1, max: question.scale_max ?? 5 };
}

function scaleLabels(question: UserQuestion): {
  min?: string;
  max?: string;
} {
  return {
    ...(question.scale_min_label ? { min: question.scale_min_label } : {}),
    ...(question.scale_max_label ? { max: question.scale_max_label } : {}),
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
