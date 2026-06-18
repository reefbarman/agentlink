import type { FinalMessageMarker } from "../../shared/finalStatus.js";

export type UserQuestionType =
  | "multiple_choice"
  | "multiple_select"
  | "yes_no"
  | "text"
  | "scale"
  | "confirmation";

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

export interface UserQuestionResponse {
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
}

export interface UserQuestionProvider {
  ask(request: UserQuestionRequest): Promise<UserQuestionResponse>;
}

export interface SessionStatusProvider {
  setFinalStatus(marker: FinalMessageMarker): void;
  completeTodos?(): readonly unknown[];
}

export interface ModeSwitchRequest {
  mode: string;
  reason?: string;
  silent?: boolean;
}

export interface ModeSwitchResult {
  approved: boolean;
  mode: string;
  followUp?: string;
  rejectionReason?: string;
}

export interface ModeSwitchProvider {
  switchMode(request: ModeSwitchRequest): Promise<ModeSwitchResult>;
}
