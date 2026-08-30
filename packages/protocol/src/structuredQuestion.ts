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

export interface UserQuestionResponse {
  answers: Record<string, UserQuestionAnswer>;
  notes: Record<string, string>;
  attachments?: Record<string, UserQuestionAttachment[]>;
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
