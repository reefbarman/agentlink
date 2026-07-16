import type { AppState } from "../shared/chatProjection.js";
import type { ChatMessage } from "./webview/types.js";
import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";

export interface BrowserForegroundSnapshot {
  sessionId: string;
  mode: string;
  model: string;
  streaming: boolean;
  interrupted?: boolean;
  statusOverride: string | null;
  projectedMessages: ChatMessage[];
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  estimatedTotalUsed: number;
  thinkingEnabled: boolean;
  reasoningEffort: NonNullable<AppState["chatState"]["reasoningEffort"]>;
  messageQueue: AppState["messageQueue"];
  questionRequest: AppState["questionRequest"];
  detectedQuestion: AppState["detectedQuestion"];
  todos: AppState["todos"];
  debugInfo: AppState["debugInfo"];
  systemPrompt: AppState["systemPrompt"];
  loadedInstructions: AppState["loadedInstructions"];
  restoringSession: AppState["restoringSession"];
  contextBudget?: AppState["chatState"]["contextBudget"];
  condenseThreshold?: AppState["chatState"]["condenseThreshold"];
  commandApprovalPolicy?: CommandApprovalPolicy;
  configuredCommandApprovalPolicy?: Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  >;
  revertRecoveryNotice: AppState["revertRecoveryNotice"];
}

export function createBrowserForegroundSnapshot(
  sessionId: string,
  state: AppState,
): BrowserForegroundSnapshot {
  return {
    sessionId,
    mode: state.chatState.mode,
    model: state.chatState.model,
    streaming: state.streaming,
    interrupted: state.chatState.interrupted,
    statusOverride: state.statusOverride,
    projectedMessages: [...state.messages],
    lastInputTokens: state.lastInputTokens,
    lastOutputTokens: state.lastOutputTokens,
    lastCacheReadTokens: state.lastCacheReadTokens,
    estimatedTotalUsed: state.estimatedTotalUsed,
    thinkingEnabled: state.thinkingEnabled,
    reasoningEffort:
      state.chatState.reasoningEffort ??
      (state.thinkingEnabled ? "high" : "none"),
    messageQueue: state.messageQueue.map((entry) => ({
      ...entry,
      attachments: entry.attachments ? [...entry.attachments] : undefined,
      images: entry.images
        ? entry.images.map((image) => ({ ...image }))
        : undefined,
      documents: entry.documents
        ? entry.documents.map((document) => ({ ...document }))
        : undefined,
    })),
    questionRequest: state.questionRequest
      ? {
          id: state.questionRequest.id,
          context: state.questionRequest.context,
          questions: state.questionRequest.questions.map((question) => ({
            ...question,
          })),
          ...(state.questionRequest.backgroundTask
            ? { backgroundTask: state.questionRequest.backgroundTask }
            : {}),
        }
      : null,
    detectedQuestion: state.detectedQuestion
      ? {
          ...state.detectedQuestion,
          options: state.detectedQuestion.options.map((option) => ({
            ...option,
          })),
        }
      : null,
    todos: state.todos.map((todo) => ({ ...todo })),
    debugInfo: state.debugInfo ? { ...state.debugInfo } : null,
    systemPrompt: state.systemPrompt,
    loadedInstructions: state.loadedInstructions
      ? state.loadedInstructions.map((item) => ({ ...item }))
      : null,
    restoringSession: state.restoringSession,
    contextBudget: state.chatState.contextBudget
      ? { ...state.chatState.contextBudget }
      : undefined,
    condenseThreshold: state.chatState.condenseThreshold,
    commandApprovalPolicy: state.chatState.commandApprovalPolicy,
    configuredCommandApprovalPolicy:
      state.chatState.configuredCommandApprovalPolicy,
    revertRecoveryNotice: state.revertRecoveryNotice
      ? { ...state.revertRecoveryNotice }
      : null,
  };
}
