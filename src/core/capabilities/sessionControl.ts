import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import type {
  UserQuestionRequest,
  UserQuestionResponse,
} from "@agentlink/protocol/structured-question";

export {
  normalizeUserQuestionAttachments,
  type StructuredQuestionProgress,
  type StructuredQuestionRequest,
  type UserQuestion,
  type UserQuestionAnswer,
  type UserQuestionAttachment,
  type UserQuestionRequest,
  type UserQuestionResponse,
  type UserQuestionType,
} from "@agentlink/protocol/structured-question";

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
