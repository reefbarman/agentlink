export type UserQuestionType =
  | "multiple_choice"
  | "multiple_select"
  | "yes_no"
  | "text"
  | "scale"
  | "confirmation";

export type UserQuestionAnswer =
  | string
  | string[]
  | number
  | boolean
  | undefined;

export interface UserQuestion {
  id: string;
  type: UserQuestionType;
  question: string;
  context?: string;
  options?: string[];
  recommended?: string;
  allowBlank?: boolean;
  scale_min?: number;
  scale_max?: number;
  scale_min_label?: string;
  scale_max_label?: string;
  modeSwitch?: Record<string, string>;
}

export interface UserQuestionRequest {
  context: string;
  questions: UserQuestion[];
  sessionId: string;
}

/** Serializable request addressed to a specific UI interaction. */
export interface StructuredQuestionRequest {
  id: string;
  toolCallId?: string;
  context: string;
  questions: UserQuestion[];
  backgroundTask?: string;
}

export interface StructuredQuestionProgress {
  id: string;
  step: number;
  answers: Record<string, UserQuestionAnswer>;
  notes: Record<string, string>;
  origin: string;
}

export interface UserQuestionAttachment {
  kind: "file" | "image" | "document";
  name: string;
  mimeType?: string;
  path?: string;
  base64?: string;
}

/** Host-issued literal subject of a decision, never copied from response JSON. */
export interface HumanQuestionBinding {
  schemaVersion: 1;
  sessionId: string;
  questionRequestId: string;
  toolCallId: string;
  context: string;
  questions: UserQuestion[];
}

/** Internal host metadata. UI clients submit only answers, notes and attachments. */
export interface HumanQuestionAnswer {
  source: "human_ui";
  binding: HumanQuestionBinding;
  answers: Record<string, UserQuestionAnswer>;
  notes: Record<string, string>;
}

export interface UserQuestionResponse {
  answers: Record<string, UserQuestionAnswer>;
  notes: Record<string, string>;
  attachments?: Record<string, UserQuestionAttachment[]>;
  humanQuestionAnswer?: HumanQuestionAnswer;
  /** Actual host-issued request identity, not a client response field. */
  questionRequestId?: string;
}

/** Select only answered, valid fields for the literal questions the host issued. */
export function collectHumanQuestionAnswer(
  binding: HumanQuestionBinding,
  response: Pick<UserQuestionResponse, "answers" | "notes">,
): HumanQuestionAnswer | undefined {
  const answers: HumanQuestionAnswer["answers"] = {};
  const notes: HumanQuestionAnswer["notes"] = {};
  for (const question of binding.questions) {
    const answer = response.answers[question.id];
    const note = response.notes[question.id];
    const valid = (() => {
      switch (question.type) {
        case "text":
          return (
            typeof answer === "string" &&
            (question.allowBlank || !!answer.trim())
          );
        case "yes_no":
          return typeof answer === "boolean";
        case "confirmation":
          return (
            typeof answer === "string" &&
            (question.options ?? ["Yes", "No"]).includes(answer)
          );
        case "multiple_choice":
          return (
            typeof answer === "string" && !!question.options?.includes(answer)
          );
        case "multiple_select":
          return (
            Array.isArray(answer) &&
            answer.length > 0 &&
            answer.every(
              (item) =>
                typeof item === "string" && question.options?.includes(item),
            )
          );
        case "scale":
          return (
            typeof answer === "number" &&
            Number.isFinite(answer) &&
            answer >= (question.scale_min ?? 1) &&
            answer <= (question.scale_max ?? 5)
          );
      }
    })();
    if (valid) answers[question.id] = structuredClone(answer);
    if (typeof note === "string" && note.trim()) notes[question.id] = note;
  }
  if (!Object.keys(answers).length && !Object.keys(notes).length)
    return undefined;
  return {
    source: "human_ui",
    binding: structuredClone(binding),
    answers,
    notes,
  };
}

export function normalizeUserQuestionAttachments(
  value: unknown,
): NonNullable<UserQuestionResponse["attachments"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: NonNullable<UserQuestionResponse["attachments"]> = {};
  for (const [questionId, rawItems] of Object.entries(value)) {
    if (!Array.isArray(rawItems)) continue;
    const items: UserQuestionAttachment[] = [];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const kind = item.kind;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (
        (kind !== "file" && kind !== "image" && kind !== "document") ||
        !name
      ) {
        continue;
      }
      items.push({
        kind,
        name,
        ...(typeof item.mimeType === "string" && item.mimeType.trim()
          ? { mimeType: item.mimeType.trim() }
          : {}),
        ...(typeof item.path === "string" && item.path.trim()
          ? { path: item.path.trim() }
          : {}),
        ...(typeof item.base64 === "string" && item.base64
          ? { base64: item.base64 }
          : {}),
      });
    }
    if (items.length > 0) result[questionId] = items;
  }
  return result;
}
