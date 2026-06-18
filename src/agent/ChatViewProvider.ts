import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { providerRegistry } from "./providers/index.js";
import type { ModelProvider } from "./providers/types.js";
import type {
  ChatMessage,
  ExtensionMessage,
  SlashCommandInfo,
  WebviewModelInfo,
} from "./webview/types.js";
import { getConfiguredBaseThresholdForModel } from "./modelCondenseThresholds.js";
import { getModeModelPreferences } from "./modeModelPreferences.js";
import type {
  AgentSessionManager,
  CheckpointRevertResult,
  PersistedSessionMutationResult,
} from "./AgentSessionManager.js";
import type { AgentSession } from "./AgentSession.js";
import type { SessionSummary } from "./SessionStore.js";
import type { RevertRecoveryState } from "./persistenceContracts.js";
import type { AgentErrorActions, AgentEvent } from "./types.js";
import type {
  BrowserGatewayThemeSnapshot,
  McpApprovalPromotionMeta,
  RequestContextBreakdown,
  RevertRecoveryNotice,
} from "../shared/types.js";
import type { McpUrlElicitationRequest } from "../shared/mcpUrlElicitation.js";
import { withPrimaryEditorColumn } from "../util/editorPlacement.js";
import type { InstructionBlock } from "./configLoader.js";
import {
  getFinalMessageContinueAction,
  type FinalMessageMarker,
} from "../shared/finalStatus.js";
import type { TodoItem } from "./todoTool.js";
import { SlashCommandRegistry } from "./SlashCommandRegistry.js";
import { McpClientHub, type McpServerInfo } from "./McpClientHub.js";
import {
  type AgentUiPublisher,
  FanoutAgentUiPublisher,
  InMemoryAgentUiEventHub,
  type ReadableAgentUiEventHub,
  WebviewAgentUiPublisher,
} from "./AgentUiPublisher.js";
import {
  loadMcpConfigs,
  getMcpConfigFilePaths,
  persistMcpToolApproval,
} from "./mcpConfig.js";
import { loadCustomModes, getAllModes } from "./modes.js";
import {
  buildSystemPrompt,
  formatRuleCatalogPath,
  getRuleCatalogSummary,
  shouldInlineInstructionBlock,
} from "./systemPrompt.js";
import { loadAllInstructionBlocks } from "./configLoader.js";
import type {
  ApprovalRequest,
  DecisionMessage,
} from "../approvals/webview/types.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ToolCallTracker } from "../server/ToolCallTracker.js";
import { DIFF_VIEW_URI_SCHEME } from "../extension.js";
import { getRelativePath } from "../util/paths.js";
import {
  detectQuestion,
  getQuestionDetectionMode,
} from "./questionDetectionLlm.js";
import { detectQuestionFromAssistantText } from "./webview/questionDetection.js";
import type { DetectedQuestion } from "../shared/questionDetection.js";
import {
  agentMessagesToChatMessages,
  initialState,
  reducer,
  shouldAcceptSessionChunk,
  shouldDropSessionScopedEvent,
  type AppState,
  type LoadedInstructionDebugInfo,
} from "../shared/chatProjection.js";
import { stripMemoryCandidateReminders } from "../shared/memoryCandidates.js";

type DisplayMedia = NonNullable<ChatMessage["displayMedia"]>;
type RawDisplayImage = { name: string; mimeType: string; base64: string };
type RawDisplayDocument = { name: string; mimeType: string; base64?: string };

function hasFinalContinueAction(message: ChatMessage): boolean {
  return Boolean(
    message.finalMarker && getFinalMessageContinueAction(message.finalMarker),
  );
}

export function formatPersistedSessionMutationFailureMessage(
  result: Exclude<PersistedSessionMutationResult, { ok: true }>,
): string {
  const operationLabel = result.operation === "rename" ? "rename" : "delete";
  switch (result.reason) {
    case "conflict":
      return `Could not ${operationLabel} the session because it changed on disk. Refresh session history and try again.`;
    case "not_owner":
      return `Could not ${operationLabel} the session because another AgentLink runtime owns it. Close the other runtime or reload session history before trying again.`;
    case "not_found":
      return `Could not ${operationLabel} the session because it is no longer available. Refresh session history.`;
    case "corrupt":
      return `Could not ${operationLabel} the session because its persisted files look corrupt. Check the AgentLink Agent output channel before trying again.${result.message ? ` ${result.message}` : ""}`;
    case "io_error":
      return `Could not ${operationLabel} the session because AgentLink could not write the session files. Check file permissions and the AgentLink Agent output channel before trying again.${result.message ? ` ${result.message}` : ""}`;
  }
}

export function formatRevertRecoveryNotice(
  recovery: RevertRecoveryState,
): RevertRecoveryNotice {
  const workspaceSuffix = recovery.workspaceRevision
    ? ` Workspace revision: ${recovery.workspaceRevision.slice(0, 12)}.`
    : "";
  return {
    checkpointId: recovery.checkpointId,
    sessionRevision: recovery.sessionRevision,
    workspaceRevision: recovery.workspaceRevision,
    startedAt: recovery.startedAt,
    title: "Checkpoint revert needs transcript recovery",
    message: `Workspace files were reverted to checkpoint ${recovery.checkpointId}, but AgentLink could not save the reverted transcript. Recovery metadata is recorded in the session; reload the session or check the AgentLink Agent output channel before continuing.${workspaceSuffix}`,
  };
}

export function formatCheckpointRevertFailureMessage(
  result: Exclude<CheckpointRevertResult, { ok: true }>,
): string {
  switch (result.reason) {
    case "session_conflict":
      return "Checkpoint revert was cancelled because the session changed after the preview. Refresh the checkpoint preview and try again.";
    case "checkpoint_stale":
      return "Checkpoint revert was cancelled because the checkpoint no longer matches the current transcript. Refresh the session and try again.";
    case "workspace_revert_failed":
      return "Failed to revert workspace files to the checkpoint. The transcript was not changed.";
    case "persistence_failed":
      return "Workspace files were reverted, but AgentLink could not save the reverted transcript. AgentLink recorded recovery metadata and kept the in-memory transcript unchanged; reload the session or check the AgentLink Agent output channel before continuing.";
    case "not_found":
      return "Checkpoint revert failed because the checkpoint or session is no longer available. Refresh the session and try again.";
  }
}

function mediaToDisplayMedia(
  media:
    | {
        images?: RawDisplayImage[];
        documents?: RawDisplayDocument[];
      }
    | undefined,
): DisplayMedia | undefined {
  if (!media?.images?.length && !media?.documents?.length) return undefined;
  return {
    images:
      media.images?.map((image) => ({
        name: image.name,
        mimeType: image.mimeType,
        src: `data:${image.mimeType};base64,${image.base64}`,
      })) ?? [],
    documents:
      media.documents?.map((document) => ({
        name: document.name,
        mimeType: document.mimeType,
      })) ?? [],
  };
}

function formatInstructionDebugInfo(
  block: InstructionBlock,
  cwd: string,
  activeFilePath?: string,
): LoadedInstructionDebugInfo {
  const deferred = !shouldInlineInstructionBlock(block, cwd, {
    activeFilePath,
  });
  const loadPath = block.filePath
    ? formatRuleCatalogPath(block, cwd)
    : undefined;
  const summary =
    block.kind === "rule"
      ? getRuleCatalogSummary(block.content, block.description)
      : undefined;

  return {
    source: block.source,
    chars: block.content.length,
    promptChars: deferred ? 0 : block.content.length,
    kind: block.kind ?? "instruction",
    deferred,
    hasFrontmatter: block.hasFrontmatter,
    alwaysApply: block.alwaysApply,
    loadPath,
    summary,
    globs: block.globs,
  };
}

/**
 * Webview protocol types — messages between extension and chat webview.
 * Mirrored in src/agent/webview/types.ts for the browser side.
 */
export type ExtensionToWebview =
  | { type: "stateUpdate"; state: ChatState }
  | { type: "agentThinkingStart"; sessionId: string; thinkingId: string }
  | {
      type: "agentThinkingDelta";
      sessionId: string;
      thinkingId: string;
      text: string;
    }
  | { type: "agentThinkingEnd"; sessionId: string; thinkingId: string }
  | { type: "agentTextDelta"; sessionId: string; text: string }
  | {
      type: "agentToolStart";
      sessionId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "agentToolInputDelta";
      sessionId: string;
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "agentToolComplete";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
      input?: unknown;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
    }
  | {
      type: "agentUserAnnotation";
      sessionId: string;
      text: string;
      badge: "follow-up" | "rejection";
    }
  | {
      type: "agentTodoUpdate";
      sessionId: string;
      todos: TodoItem[];
    }
  | {
      type: "agentFinalMarker";
      sessionId: string;
      marker: FinalMessageMarker | null;
    }
  | {
      type: "agentApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationMs: number;
      timeToFirstToken: number;
      usedPreviousResponseId?: boolean;
      previousResponseIdFallback?: boolean;
      promptCacheKey?: string;
      promptCacheRetention?: "in_memory" | "24h";
      storeResponseState?: boolean;
      providerResponseId?: string;
      contextBreakdown?: RequestContextBreakdown;
    }
  | {
      type: "agentError";
      sessionId: string;
      error: string;
      retryable: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "agentDone";
      sessionId: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
    }
  | { type: "agentInteractionPromptsCleared"; sessionId: string }
  | {
      type: "agentQueuedMessage";
      sessionId: string;
      queueId: string;
      text: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      attachments?: string[];
      images?: RawDisplayImage[];
      documents?: RawDisplayDocument[];
      displayMedia?: DisplayMedia;
      source?: "vscode" | "browser";
    }
  | {
      type: "agentRemoveQueuedMessage";
      sessionId: string;
      queueId: string;
    }
  | {
      type: "agentSessionUpdate";
      sessions: import("./types.js").SessionInfo[];
    }
  | {
      type: "agentFileSearchResults";
      requestId: string;
      files: Array<{ path: string; kind: "file" | "folder" }>;
    }
  | {
      type: "agentDetectQuestionResult";
      requestId: string;
      messageId: string;
      detected:
        | import("../shared/questionDetection.js").DetectedQuestion
        | null;
      fallback: boolean;
    }
  | {
      type: "agentInjectPrompt";
      prompt: string;
      attachments: string[];
      autoSubmit?: boolean;
    }
  | { type: "agentInjectAttachment"; path: string }
  | { type: "agentInjectContext"; context: string }
  | { type: "agentDroppedFilesResolved"; files: string[] }
  | {
      type: "agentModesUpdate";
      modes: Array<{ slug: string; name: string; icon: string }>;
    }
  | {
      type: "agentSlashCommandsUpdate";
      commands: Array<{
        name: string;
        description: string;
        source: string;
        builtin: boolean;
        body?: string;
      }>;
    }
  | {
      type: "agentModelsUpdate";
      models: Array<{
        id: string;
        displayName: string;
        provider: string;
        contextWindow: number;
        maxInputTokens?: number;
        maxOutputTokens?: number;
        authenticated: boolean;
      }>;
    }
  | { type: "agentModeSwitchRequest"; mode: string; reason?: string }
  | {
      type: "agentElicitationRequest";
      id: string;
      serverName: string;
      message: string;
      fields: Record<
        string,
        {
          type: "string" | "number" | "boolean";
          title?: string;
          description?: string;
          enum?: string[];
          default?: unknown;
          minimum?: number;
          maximum?: number;
          minLength?: number;
          maxLength?: number;
        }
      >;
      required: string[];
    }
  | { type: "agentUrlElicitationRequest"; request: McpUrlElicitationRequest }
  | { type: "agentUrlElicitationCleared"; id: string }
  | {
      type: "agentMcpStatus";
      open?: boolean;
      infos: Array<{
        name: string;
        status: string;
        error?: string;
        toolCount: number;
        resourceCount: number;
        promptCount: number;
      }>;
    }
  | { type: "showApproval"; request: ApprovalRequest }
  | { type: "idle" }
  | {
      type: "regexSuggestion";
      requestId: string;
      pattern?: string;
      error?: string;
    }
  | {
      type: "agentQuestionRequest";
      id: string;
      context: string;
      questions: import("./webview/types.js").Question[];
      backgroundTask?: string;
    }
  | { type: "agentQuestionCleared"; id: string }
  | {
      type: "agentQuestionProgress";
      id: string;
      step: number;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
      origin: string;
    }
  | {
      type: "agentCondense";
      sessionId: string;
      prevInputTokens: number;
      newInputTokens: number;
      summary: string;
      durationMs: number;
      validationWarnings?: string[];
      metadata?: {
        inputMessageCount: number;
        sourceUserMessageCount: number;
        hadPriorSummaryInInput: boolean;

        sourceHash: string;
        providerId: string;
        condenseModel: string;
        modelCandidates: string[];
        selectedModel: string;
        latestUserMessage: string;
        currentTask: string;
        pendingTasks: string[];
        canonicalUserMessages: string[];
        requestMessageCount: number;
        effectiveHistoryMessageCount: number;
        effectiveHistoryRoles: string[];
      };
    }
  | {
      type: "agentCondenseError";
      sessionId: string;
      error: string;
      retryable?: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "agentCondenseStart";
      sessionId: string;
      isAutomatic: boolean;
    }
  | {
      type: "agentTokenEstimate";
      sessionId: string;
      /** Running estimate of total context window usage (tokens). */
      estimatedTotalUsed: number;
    }
  | {
      type: "agentWarning";
      sessionId: string;
      message: string;
      retryDelayMs?: number;
      retryAt?: number;
      retryAttempt?: number;
      retryMaxAttempts?: number;
    }
  | {
      type: "agentStatusUpdate";
      sessionId: string;
      message: string;
    }
  | {
      type: "agentSessionList";
      sessions: import("./SessionStore.js").SessionSummary[];
    }
  | { type: "agentRestoreSessionStart" }
  | { type: "agentRestoreSessionDone" }
  | {
      type: "agentSessionLoaded";
      sessionId: string;
      title: string;
      mode: string;
      model: string;
      messages: import("./types.js").AgentMessage[];
      lastInputTokens: number;
      lastOutputTokens: number;
      /** True when this came from automatic startup restore rather than explicit user action. */
      restored?: boolean;
      /**
       * Restored checkpoints keyed by the number of visible user turns already
       * committed at that snapshot.
       */
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
      /** Number of user turns before the first message in this chunk. */
      userTurnOffset?: number;
      /** True when older messages still exist before this chunk. */
      hasMoreBefore?: boolean;
    }
  | {
      type: "agentSessionChunk";
      sessionId: string;
      messages: import("./types.js").AgentMessage[];
      /** Number of user turns before the first message in this chunk. */
      userTurnOffset: number;
      /** True when older messages still exist before this chunk. */
      hasMoreBefore: boolean;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    }
  | {
      type: "agentCheckpointCreated";
      sessionId: string;
      checkpointId: string;
      turnIndex: number;
    }
  | {
      type: "agentBgSessionsUpdate";
      sessions: import("../shared/types.js").BgSessionInfo[];
    }
  | { type: "agentBgThinkingStart"; sessionId: string; thinkingId: string }
  | {
      type: "agentBgThinkingDelta";
      sessionId: string;
      thinkingId: string;
      text: string;
    }
  | { type: "agentBgThinkingEnd"; sessionId: string; thinkingId: string }
  | { type: "agentBgTextDelta"; sessionId: string; text: string }
  | {
      type: "agentBgToolStart";
      sessionId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "agentBgToolInputDelta";
      sessionId: string;
      toolCallId: string;
      partialJson: string;
    }
  | {
      type: "agentBgToolComplete";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      result: string;
      durationMs: number;
      input?: unknown;
    }
  | {
      type: "agentBgApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      durationMs: number;
      timeToFirstToken: number;
      usedPreviousResponseId?: boolean;
      previousResponseIdFallback?: boolean;
      promptCacheKey?: string;
      promptCacheRetention?: "in_memory" | "24h";
      storeResponseState?: boolean;
      providerResponseId?: string;
    }
  | {
      type: "agentBgError";
      sessionId: string;
      error: string;
      retryable: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "agentBgDone";
      sessionId: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      resultText?: string;
      resultSummary?: string;
    }
  | {
      type: "agentInterjection";
      sessionId: string;
      text: string;
      queueId: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      displayMedia?: DisplayMedia;
    }
  | {
      type: "agentQueuedMessage";
      sessionId: string;
      text: string;
      queueId: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      attachments?: string[];
      images?: RawDisplayImage[];
      documents?: RawDisplayDocument[];
      displayMedia?: DisplayMedia;
      source?: "vscode" | "browser";
    }
  | {
      type: "agentRemoveQueuedMessage";
      sessionId: string;
      queueId: string;
    }
  | {
      type: "agentCommittedUserMessage";
      sessionId: string;
      id?: string;
      text: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      origin?: "vscode" | "browser";
      displayMedia?: DisplayMedia;
    }
  | {
      type: "agentDebugInfo";
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: LoadedInstructionDebugInfo[];
    }
  | {
      type: "showBgTranscript";
      sessionId: string;
      task: string;
      messages: unknown[];
    }
  | { type: "agentBtwLoading"; requestId: string; question: string }
  | {
      type: "agentBtwResponse";
      requestId: string;
      question: string;
      answer: string;
      error?: boolean;
    }
  | {
      type: "agentPairingCode";
      pairingId: string;
      code: string;
      expiresAt: number;
      pairingUrls: string[];
    }
  | {
      type: "agentPairingStatus";
      pairingId: string;
      status: "pending" | "consumed" | "expired" | "cancelled";
      deviceId?: string;
      deviceLabel?: string;
    };

export interface ChatState {
  sessionId: string | null;
  mode: string;
  model: string;
  streaming: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: import("./providers/types.js").ReasoningEffort;
  condenseThreshold?: number;
  contextBudget?: {
    contextWindow: number;
    maxInputTokens: number;
    usedInputTokens: number;
    outputReservation: number;
    safetyBufferTokens: number;
    softThresholdBudget: number;
    hardBudget: number;
  };
  agentWriteApproval?: "prompt" | "session" | "project" | "global";
  revertRecoveryNotice?: RevertRecoveryNotice | null;
}

type ContextBudget = NonNullable<ChatState["contextBudget"]>;

const RESTORE_TAIL_TURNS = 8;
const RESTORE_BACKFILL_BATCH_TURNS = 12;

/**
 * Drop attached media (base64 images/PDFs) before sending raw messages to a
 * UI surface — transcripts only render text, and the payloads can be megabytes.
 */
function stripMediaForTransport(
  messages: import("./types.js").AgentMessage[],
): import("./types.js").AgentMessage[] {
  return messages.map((m) => {
    if (!m.media) return m;
    const { media: _media, ...rest } = m;
    return rest;
  });
}

function countUserTurns(messages: import("./types.js").AgentMessage[]): number {
  let count = 0;
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") count++;
  }
  return count;
}

function getTailChunkByUserTurns(
  messages: import("./types.js").AgentMessage[],
  tailTurns: number,
): {
  chunk: import("./types.js").AgentMessage[];
  userTurnOffset: number;
  hasMoreBefore: boolean;
} {
  if (messages.length === 0) {
    return { chunk: [], userTurnOffset: 0, hasMoreBefore: false };
  }

  if (tailTurns <= 0) {
    return {
      chunk: [...messages],
      userTurnOffset: 0,
      hasMoreBefore: false,
    };
  }

  let seenUserTurns = 0;
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") {
      seenUserTurns++;
      if (seenUserTurns > tailTurns) {
        startIndex = i + 1;
        break;
      }
    }
  }

  const chunk = messages.slice(startIndex);
  const prefix = messages.slice(0, startIndex);
  const userTurnOffset = countUserTurns(prefix);
  return {
    chunk,
    userTurnOffset,
    hasMoreBefore: startIndex > 0,
  };
}

function getBackfillChunksByUserTurns(
  prefix: import("./types.js").AgentMessage[],
  batchTurns: number,
): Array<{
  messages: import("./types.js").AgentMessage[];
  userTurnOffset: number;
  hasMoreBefore: boolean;
}> {
  if (prefix.length === 0) return [];
  const batch = Math.max(1, batchTurns);

  const chunks: Array<{
    messages: import("./types.js").AgentMessage[];
    userTurnOffset: number;
    hasMoreBefore: boolean;
  }> = [];

  let cursor = prefix.length;
  while (cursor > 0) {
    let turnsInChunk = 0;
    let start = cursor;
    for (let i = cursor - 1; i >= 0; i--) {
      start = i;
      const m = prefix[i];
      if (m.role === "user" && typeof m.content === "string") {
        turnsInChunk++;
        if (turnsInChunk >= batch) break;
      }
    }

    const chunkMessages = prefix.slice(start, cursor);
    const userTurnOffset = countUserTurns(prefix.slice(0, start));
    chunks.push({
      messages: chunkMessages,
      userTurnOffset,
      hasMoreBefore: start > 0,
    });
    cursor = start;
  }

  return chunks.reverse();
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentLink.chatView";

  private view: vscode.WebviewView | undefined;
  private sessionManager: AgentSessionManager | undefined;
  private outputChannel: vscode.OutputChannel;
  private webviewReady = false;
  private pendingMessages: ExtensionToWebview[] = [];
  private slashRegistry: SlashCommandRegistry | undefined;
  private mcpHub: McpClientHub;
  private fileWatchers: vscode.Disposable[] = [];
  private cwd: string = "";
  private pendingElicitations = new Map<
    string,
    { resolve: (values: Record<string, unknown>) => void; cancel: () => void }
  >();
  private pendingUrlElicitations = new Map<
    string,
    {
      request: McpUrlElicitationRequest;
      resolve: (action: "accept" | "cancel" | "decline") => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  >();
  /** Tracks which pending-elicitation IDs belong to each session, for scoped cancellation on stop */
  private elicitationSessionIndex = new Map<string, Set<string>>();
  private pendingApprovals = new Map<
    string,
    (
      result:
        | string
        | {
            decision: string;
            rejectionReason?: string;
            followUp?: string;
            trustScope?: string;
            rulePattern?: string;
            ruleMode?: string;
            editedContent?: string;
            memoryTier?: import("../approvals/webview/types.js").MemoryTier;
            memoryScope?: import("../approvals/webview/types.js").MemoryScope;
            memoryName?: string;
          },
    ) => void
  >();
  private pendingForwardedApprovals = new Map<
    string,
    (msg: DecisionMessage) => void
  >();
  private activeApprovalRequests = new Map<string, ApprovalRequest>();
  private activeApprovalOrder: string[] = [];
  private visibleApprovalId: string | null = null;
  private pendingQuestions = new Map<
    string,
    (response: {
      answers: Record<string, unknown>;
      notes: Record<string, string>;
    }) => void
  >();
  /** Tracks which pending-question IDs belong to each session, for scoped cancellation on stop */
  private questionSessionIndex = new Map<string, Set<string>>();
  /** Tracks which pending-approval IDs belong to each session, for scoped cancellation on stop */
  private approvalSessionIndex = new Map<string, Set<string>>();

  private condenseStartTimes = new Map<string, number>();
  private bgUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  // Buffers for coalescing high-frequency streaming deltas before postMessage IPC.
  private textDeltaBuffer = new Map<string, string>();
  private thinkingDeltaBuffer = new Map<string, Map<string, string>>();
  private toolInputDeltaBuffer = new Map<string, Map<string, string>>();
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private streamDropCounts = {
    sessionMismatch: 0,
    streamingFalse: 0,
  };
  private streamDropLogTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalManager: ApprovalManager | undefined;
  private approvalManagerListener: vscode.Disposable | undefined;
  private toolCallTracker: ToolCallTracker | undefined;
  private anthropicProvider: ModelProvider | undefined;
  private notifyBrowserModelsChanged: (() => void) | undefined;
  private anthropicModelsRefreshInFlight: Promise<void> | undefined;
  private browserGatewayAdminClient:
    | import("../browser-gateway/helper/BrowserGatewayHelperAdminClient.js").BrowserGatewayHelperAdminClient
    | undefined;
  private pairingPollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private specialBlockPanel: vscode.WebviewPanel | undefined;
  private lastMcpStatuses = new Map<
    string,
    { status: string; error?: string }
  >();
  private readonly uiEventHub: InMemoryAgentUiEventHub;
  private readonly uiPublisher: AgentUiPublisher;
  private browserGatewayThemeSnapshot: BrowserGatewayThemeSnapshot | null =
    null;
  private projectedForegroundState: AppState = {
    ...initialState,
  };
  private projectedForegroundSessionId: string | null = null;
  private projectedForegroundLoadingSessionId: string | null = null;
  private projectedForegroundStreaming = false;
  private projectedDetectRequest: {
    requestId: string;
    messageId: string;
    assistantText: string;
  } | null = null;
  private projectedLastDetectKey: string | null = null;
  private detectRequestInputs = new Map<
    string,
    { messageId: string; assistantText: string; detectKey: string }
  >();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
  ) {
    this.outputChannel = vscode.window.createOutputChannel("AgentLink Agent");
    this.uiEventHub = new InMemoryAgentUiEventHub();
    this.uiPublisher = new FanoutAgentUiPublisher([
      new WebviewAgentUiPublisher((message) => {
        this.postMessage(message);
      }),
      this.uiEventHub,
    ]);
    this.mcpHub = new McpClientHub(globalState);
    this.mcpHub.onSampling = async ({
      messages,
      systemPrompt,
      maxTokens,
      model,
    }) => {
      const targetModel = model ?? "claude-sonnet-4-6";
      const provider = providerRegistry.tryResolveProvider(targetModel);
      if (!provider) {
        return {
          role: "assistant",
          content: "Sampling unavailable: no provider for model.",
        };
      }
      try {
        const result = await provider.complete({
          model: targetModel,
          systemPrompt: systemPrompt ?? "",
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          maxTokens,
        });
        return { role: "assistant", content: result.text };
      } catch {
        return {
          role: "assistant",
          content: "Sampling failed.",
        };
      }
    };

    this.mcpHub.onElicitation = (request, resolve, cancel) => {
      const id = `elicit_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.pendingElicitations.set(id, { resolve, cancel });
      // Best-effort attribution: MCP elicitation callbacks do not currently carry
      // agent session context, so we associate with the foreground session.
      // If background MCP tool calls start elicitation, precise attribution will
      // require threading sessionId through McpClientHub.onElicitation.
      const sessionId = this.sessionManager?.getForegroundSession()?.id;
      if (sessionId) {
        const sessionSet =
          this.elicitationSessionIndex.get(sessionId) ?? new Set();
        sessionSet.add(id);
        this.elicitationSessionIndex.set(sessionId, sessionSet);
      }
      this.postMessage({
        type: "agentElicitationRequest",
        id,
        serverName: request.serverName,
        message: request.message,
        fields: request.fields,
        required: request.required,
      } as unknown as ExtensionToWebview);
    };

    this.mcpHub.onUrlElicitation = (request, resolve) => {
      this.cancelPendingUrlElicitations();
      this.pendingUrlElicitations.set(request.id, { request, resolve });
      if (request.expiresAt) {
        const delay = Math.max(0, request.expiresAt - Date.now());
        const pending = this.pendingUrlElicitations.get(request.id);
        if (pending) {
          pending.timeout = setTimeout(() => {
            this.resolveUrlElicitation(request.id, "cancel");
          }, delay);
        }
      }
      this.uiPublisher.publishUrlElicitationRequest(request);
    };

    this.mcpHub.onUrlElicitationComplete = (_serverName, elicitationId) => {
      for (const pending of this.pendingUrlElicitations.values()) {
        if (pending.request.elicitationId === elicitationId) {
          this.clearUrlElicitation(pending.request.id);
          return;
        }
      }
    };
  }

  dispose(): void {
    // Reject all pending promises so any awaiting tool calls/question handlers
    // don't stay suspended across view lifecycle.
    for (const [id, resolve] of this.pendingQuestions) {
      resolve({ answers: {}, notes: {} });
      this.uiPublisher.publishQuestionCleared(id);
    }
    this.pendingQuestions.clear();
    this.questionSessionIndex.clear();

    for (const resolve of this.pendingApprovals.values()) {
      resolve("reject");
    }
    this.pendingApprovals.clear();
    this.approvalSessionIndex.clear();

    for (const [id, resolve] of this.pendingForwardedApprovals) {
      // Send a synthetic rejection so the approval chain unblocks.
      resolve({
        type: "decision",
        id,
        decision: "reject",
      } as import("../approvals/webview/types.js").DecisionMessage);
    }
    this.pendingForwardedApprovals.clear();
    this.activeApprovalRequests.clear();
    this.activeApprovalOrder = [];
    this.visibleApprovalId = null;

    for (const { cancel } of this.pendingElicitations.values()) {
      cancel();
    }
    this.pendingElicitations.clear();
    for (const [id, pending] of this.pendingUrlElicitations) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve("cancel");
      this.uiPublisher.publishUrlElicitationCleared(id);
    }
    this.pendingUrlElicitations.clear();
    this.elicitationSessionIndex.clear();

    this.outputChannel.dispose();
    this.uiEventHub.dispose();
    this.specialBlockPanel?.dispose();
    this.specialBlockPanel = undefined;
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    this.approvalManagerListener?.dispose();
    this.mcpHub?.disconnectAll().catch(() => undefined);
  }

  getUiEventHub(): ReadableAgentUiEventHub {
    return this.uiEventHub;
  }

  getBrowserGatewayThemeSnapshot(): BrowserGatewayThemeSnapshot {
    if (this.view && this.webviewReady && this.browserGatewayThemeSnapshot) {
      return this.browserGatewayThemeSnapshot;
    }
    return this.getFallbackThemeSnapshot();
  }

  getBrowserAgentWriteApprovalState():
    | "prompt"
    | "session"
    | "project"
    | "global" {
    const fgSessionId =
      this.sessionManager?.getForegroundSession()?.id ?? "agent";
    return (
      this.approvalManager?.getAgentWriteApprovalState(fgSessionId) ?? "prompt"
    );
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    this.approvalManagerListener?.dispose();
    this.approvalManagerListener = manager.onDidChange(() => {
      this.sendInitialState();
    });
  }

  setToolCallTracker(tracker: ToolCallTracker): void {
    this.toolCallTracker = tracker;
  }

  setBrowserGatewayAdminClient(
    client: import("../browser-gateway/helper/BrowserGatewayHelperAdminClient.js").BrowserGatewayHelperAdminClient,
  ): void {
    this.browserGatewayAdminClient = client;
  }

  /**
   * Register the Anthropic provider so model capabilities can be refreshed
   * lazily (Target A). The provider exposes an optional `listAvailableModels()`.
   */
  setAnthropicProvider(provider: ModelProvider): void {
    this.anthropicProvider = provider;
  }

  /**
   * Register a callback (wired to the browser gateway) invoked after a dynamic
   * model refresh so browser clients re-fetch `/api/models`. Keeps the gateway
   * in parity without a dedicated event type (design §5 / Q7).
   */
  setBrowserModelsChangedNotifier(notify: () => void): void {
    this.notifyBrowserModelsChanged = notify;
  }

  /**
   * Lazily refresh Anthropic dynamic model capabilities. No-op if the provider
   * has no `listAvailableModels`, dynamic capabilities are disabled, or a
   * refresh is already in-flight. The provider itself honors the TTL, so a
   * fresh cache resolves without a network call. On a change: rebuild the
   * routing index, re-send the VS Code model list, and signal the browser
   * gateway to re-fetch. `force` bypasses the TTL (explicit refresh / auth).
   */
  private maybeRefreshAnthropicModels(options?: { force?: boolean }): void {
    const provider = this.anthropicProvider;
    if (!provider?.listAvailableModels) return;
    // Flag-off kill switch: no dynamic refresh, no registry rebuild, no bump.
    const enabled = (provider as { dynamicModelCapabilitiesEnabled?: boolean })
      .dynamicModelCapabilitiesEnabled;
    if (enabled === false) return;
    // Coalesce: only one refresh in-flight at a time. Unlike a permanent guard,
    // this allows later refreshes (TTL expiry, auth change, explicit refresh).
    if (this.anthropicModelsRefreshInFlight) return;
    const listAvailableModels = provider.listAvailableModels as (opts?: {
      force?: boolean;
    }) => Promise<unknown>;
    this.anthropicModelsRefreshInFlight = listAvailableModels
      .call(provider, options)
      .then(() => {
        providerRegistry.refreshIndex();
        void this.sendModelsUpdate();
        this.notifyBrowserModelsChanged?.();
      })
      .catch((err: unknown) => {
        this.log(
          `[anthropic] dynamic model refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        this.anthropicModelsRefreshInFlight = undefined;
      });
  }

  getBrowserGatewayAdminClient():
    | import("../browser-gateway/helper/BrowserGatewayHelperAdminClient.js").BrowserGatewayHelperAdminClient
    | undefined {
    return this.browserGatewayAdminClient;
  }

  /**
   * Create a pairing code on the helper and stream its status back to the
   * webview via `agentPairingCode` + `agentPairingStatus` messages. Returns
   * the create response so VS Code commands can show a modal with the code
   * alongside the chat block.
   */
  async createBrowserPairing(): Promise<
    | import("../browser-gateway/protocol.js").BrowserGatewayPairingCreateResponse
    | null
  > {
    const admin = this.browserGatewayAdminClient;
    if (!admin) return null;
    const pairing = await admin.createPairing();
    this.postMessage({
      type: "agentPairingCode",
      pairingId: pairing.pairingId,
      code: pairing.code,
      expiresAt: new Date(pairing.expiresAt).getTime(),
      pairingUrls: pairing.pairingUrls,
    });
    this.startPairingPolling(pairing.pairingId, pairing.expiresAt);
    return pairing;
  }

  private startPairingPolling(pairingId: string, expiresAtIso: string): void {
    const existing = this.pairingPollTimers.get(pairingId);
    if (existing) clearInterval(existing);
    const expiresAtMs = new Date(expiresAtIso).getTime();
    const timer = setInterval(() => {
      void this.pollPairingStatus(pairingId, expiresAtMs);
    }, 2_000);
    this.pairingPollTimers.set(pairingId, timer);
  }

  private async pollPairingStatus(
    pairingId: string,
    expiresAtMs: number,
  ): Promise<void> {
    const admin = this.browserGatewayAdminClient;
    if (!admin) {
      this.stopPairingPolling(pairingId);
      return;
    }
    try {
      const status = await admin.getPairingStatus(pairingId);
      if (status.status !== "pending") {
        this.postMessage({
          type: "agentPairingStatus",
          pairingId,
          status: status.status,
          deviceId: status.deviceId,
          deviceLabel: status.deviceLabel,
        });
        this.stopPairingPolling(pairingId);
        return;
      }
      if (Date.now() > expiresAtMs + 1000) {
        this.postMessage({
          type: "agentPairingStatus",
          pairingId,
          status: "expired",
        });
        this.stopPairingPolling(pairingId);
      }
    } catch {
      // Keep polling — transient helper restarts can cause brief failures.
    }
  }

  private stopPairingPolling(pairingId: string): void {
    const timer = this.pairingPollTimers.get(pairingId);
    if (timer) {
      clearInterval(timer);
      this.pairingPollTimers.delete(pairingId);
    }
  }

  async handlePairCommand(): Promise<void> {
    const admin = this.browserGatewayAdminClient;
    if (!admin) {
      vscode.window.showErrorMessage(
        "AgentLink browser gateway is still starting up — try again in a second.",
      );
      return;
    }
    try {
      const pairing = await this.createBrowserPairing();
      if (!pairing) return;
      const primaryUrl = pairing.pairingUrls[0] ?? "";
      vscode.window.showInformationMessage(
        `Pairing code: ${pairing.code} — visit ${primaryUrl} on the new device within 2 minutes.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to create pairing code: ${String(err)}`,
      );
    }
  }

  async showPairedDevicesList(): Promise<void> {
    const admin = this.browserGatewayAdminClient;
    if (!admin) {
      vscode.window.showErrorMessage(
        "AgentLink browser gateway is still starting up — try again in a second.",
      );
      return;
    }
    try {
      const { devices } = await admin.listDevices();
      if (devices.length === 0) {
        vscode.window.showInformationMessage(
          "No paired browser devices. Run /pair to add one.",
        );
        return;
      }

      type DeviceQuickPickItem = vscode.QuickPickItem & { deviceId?: string };
      const items: DeviceQuickPickItem[] = devices.map((device) => ({
        label: device.label || "(unnamed device)",
        description: `last seen ${new Date(device.lastSeenAt).toLocaleString()}`,
        detail: `paired ${new Date(device.createdAt).toLocaleString()}`,
        deviceId: device.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "Paired Browser Devices",
        placeHolder: "Select a device to revoke",
        ignoreFocusOut: true,
      });
      if (!picked?.deviceId) return;

      const confirm = await vscode.window.showWarningMessage(
        `Revoke "${picked.label}"? The device will be signed out immediately.`,
        { modal: true },
        "Revoke",
      );
      if (confirm !== "Revoke") return;

      await admin.revokeDevice(picked.deviceId);
      vscode.window.showInformationMessage(`Revoked "${picked.label}".`);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to manage paired devices: ${String(err)}`,
      );
    }
  }

  /**
   * Initialize modes, slash commands, MCP hub, and file watchers.
   * Call after construction, before the webview is opened.
   */
  async initialize(cwd: string): Promise<void> {
    this.cwd = cwd;

    // Slash commands
    this.slashRegistry = new SlashCommandRegistry(cwd);
    await this.slashRegistry.reload();

    this.mcpHub.onStatusChange = (infos) => {
      if (infos.length === 0) {
        this.log(`[mcp] status update: no configured servers`);
      } else {
        const transitions: string[] = [];
        for (const info of infos) {
          const prev = this.lastMcpStatuses.get(info.name);
          const prevStatus = prev?.status ?? "unknown";
          const prevErr = prev?.error ?? "";
          const nextErr = info.error ?? "";
          const changed = prevStatus !== info.status || prevErr !== nextErr;
          if (changed) {
            const errSuffix = info.error ? ` error=${info.error}` : "";
            transitions.push(
              `${info.name}: ${prevStatus} -> ${info.status}${errSuffix}`,
            );
          }
          this.lastMcpStatuses.set(info.name, {
            status: info.status,
            error: info.error,
          });
        }

        if (transitions.length > 0) {
          this.log(`[mcp] status transition(s): ${transitions.join(" | ")}`);
        } else {
          const snapshot = infos
            .map((i) => `${i.name}=${i.status}${i.error ? `(${i.error})` : ""}`)
            .join(", ");
          this.log(`[mcp] status update (no transition): ${snapshot}`);
        }
      }

      // Push live updates to the status panel if it's open
      this.postMessage({
        type: "agentMcpStatus",
        infos,
      } as ExtensionToWebview);
    };
    this.mcpHub.onLog = (message) => {
      this.log(message);
    };
    await this.refreshMcpConnections();

    // File watchers for hot reload
    this.setupFileWatchers(cwd);

    this.log(
      `[slash] loaded ${this.slashRegistry.getAll().length} commands on init`,
    );
    // Re-send after async init completes in case webview opened during init
    void this.sendModesUpdate();
    this.sendSlashCommands();
  }

  /** Returns the MCP client hub (always defined, may not yet be connected). */
  getMcpHub(): McpClientHub {
    return this.mcpHub;
  }

  private async refreshMcpConnections(options?: {
    interactiveForNewServers?: boolean;
  }): Promise<void> {
    if (!this.mcpHub || !this.cwd) return;
    try {
      const configs = await loadMcpConfigs(this.cwd);
      await this.mcpHub.connect(configs, {
        interactiveForNewServers: options?.interactiveForNewServers,
      });
      this.log(`[mcp] connected ${configs.length} server(s)`);
    } catch (err) {
      this.log(`[mcp] connection error: ${err}`);
    }
  }

  private async openMcpConfig(scope: "project" | "global"): Promise<void> {
    if (!this.cwd) return;
    const paths = getMcpConfigFilePaths(this.cwd);
    const filePath = scope === "global" ? paths.global : paths.project;

    const fs = require("fs");
    const pathMod = require("path");

    // Create with template if missing
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(pathMod.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ mcpServers: {} }, null, 2),
        "utf-8",
      );
    }

    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, withPrimaryEditorColumn());
  }

  /** Called by the tool dispatcher when the agent requests a mode switch. */
  public async handleModeSwitch(
    mode: string,
    reason?: string,
    silent?: boolean,
  ): Promise<{
    approved: boolean;
    mode: string;
    followUp?: string;
    rejectionReason?: string;
  }> {
    const requestedBy =
      reason && reason.trim().length > 0 ? reason.trim() : "agent";

    let followUp: string | undefined;

    if (!silent) {
      try {
        const approval = await this.requestApproval({
          id: `mode-switch-${randomUUID()}`,
          kind: "mode-switch",
          title: `Switch to "${mode}" mode`,
          detail: requestedBy,
          choices: [
            { label: "Allow", value: "run-once", isPrimary: true },
            { label: "Reject", value: "reject", isDanger: true },
          ],
        });

        const decision =
          typeof approval === "string" ? approval : approval.decision;
        const rejectionReason =
          typeof approval === "string" ? undefined : approval.rejectionReason;
        followUp = typeof approval === "string" ? undefined : approval.followUp;

        if (decision === "reject") {
          const reasonText = rejectionReason?.trim() || "No reason provided";
          this.log(`[mode] denied switch to ${mode}: ${reasonText}`);
          this.postMessage({
            type: "agentUserAnnotation",
            sessionId:
              this.sessionManager?.getForegroundSession()?.id ?? "agent",
            text: `Mode switch to "${mode}" denied: ${reasonText}`,
            badge: "rejection",
          });
          return { approved: false, mode, followUp, rejectionReason };
        }
      } catch (err) {
        this.log(`[mode] approval flow failed for switch to ${mode}: ${err}`);
        return { approved: false, mode };
      }
    }

    if (!this.sessionManager) {
      this.postMessage({ type: "agentModeSwitchRequest", mode, reason });
      return { approved: true, mode, followUp };
    }

    try {
      const session = await this.sessionManager.switchForegroundMode(mode);
      if (!session) {
        // No active session yet — fall back to creating a new session in target mode.
        this.postMessage({ type: "agentModeSwitchRequest", mode, reason });
        return { approved: true, mode, followUp };
      }
      // Reset session-level write approval when switching modes — "session"
      // approval was granted for the previous mode, not the new one.
      this.approvalManager?.resetSessionAgentWriteApproval(session.id);
      this.sessionManager.queueModeSwitchResume(session.id, mode, {
        reason,
        followUp,
      });
      this.sendInitialState();
      const suffix = followUp?.trim() ? ` | ${followUp.trim()}` : "";
      const tag = silent ? " (silent)" : "";
      this.log(
        `[mode] switched foreground session ${session.id} to ${mode}${tag}${suffix}`,
      );
      return { approved: true, mode, followUp };
    } catch (err) {
      this.log(`[mode] failed to switch mode in-place: ${err}`);
      this.postMessage({ type: "agentModeSwitchRequest", mode, reason });
      return { approved: true, mode, followUp };
    }
  }

  /**
   * Forward a rich approval request (from ApprovalPanelProvider) to the chat webview.
   * Renders the actual CommandCard/WriteCard/RenameCard/PathCard components inline.
   */
  public forwardApproval(
    request: ApprovalRequest,
    respond: (msg: DecisionMessage) => void,
  ): void {
    this.pendingForwardedApprovals.set(request.id, respond);
    this.showApprovalRequest(request);
  }

  /**
   * Notify the chat webview that the forwarded approval queue is empty.
   *
   * Foreground and background approvals share one rendered card. A forwarded
   * queue becoming idle must not blindly clear an unrelated inline approval
   * that was shown while the queue was active.
   */
  public sendApprovalIdle(): void {
    this.publishVisibleApprovalOrIdle();
  }

  private showApprovalRequest(request: ApprovalRequest): void {
    if (!this.activeApprovalRequests.has(request.id)) {
      this.activeApprovalOrder.push(request.id);
    }
    this.activeApprovalRequests.set(request.id, request);
    this.visibleApprovalId = request.id;
    this.uiPublisher.publishApproval(request);
  }

  private clearApprovalRequest(id: string): void {
    if (!this.activeApprovalRequests.delete(id)) return;
    this.activeApprovalOrder = this.activeApprovalOrder.filter(
      (approvalId) => approvalId !== id,
    );
    if (this.visibleApprovalId === id) {
      this.visibleApprovalId = null;
      this.publishVisibleApprovalOrIdle();
    }
  }

  private publishVisibleApprovalOrIdle(): void {
    for (let i = this.activeApprovalOrder.length - 1; i >= 0; i -= 1) {
      const id = this.activeApprovalOrder[i];
      const request = this.activeApprovalRequests.get(id);
      if (!request) continue;
      this.visibleApprovalId = id;
      this.uiPublisher.publishApproval(request);
      return;
    }

    this.visibleApprovalId = null;
    this.uiPublisher.publishApprovalIdle();
  }

  /**
   * Ask the current foreground model to suggest a regex pattern for a command
   * approval rule. Runs in a fresh one-shot context (no tools, no session history).
   */
  public async suggestRegexForCommand(args: {
    subCommand: string;
    fullCommand: string;
  }): Promise<string> {
    const fg = this.sessionManager?.getForegroundSession();
    const model =
      fg?.model ??
      this.sessionManager?.getConfig().model ??
      "claude-sonnet-4-6";
    const provider = providerRegistry.tryResolveProvider(model);
    if (!provider) {
      throw new Error(`No provider available for model "${model}"`);
    }

    const systemPrompt = [
      "You generate JavaScript regex patterns for command approval suggestions.",
      "Given one concrete command, return a simple, reviewable regex that matches that command and useful variants for the same command shape.",
      "For read-only file-oriented commands such as wc, cat, head, tail, ls, find, grep, rg, git diff/status/log/show, and test runners, generalize file/path/glob/query/test-name inputs. Example: `wc -l README.md package.json` should become a pattern for `wc -l` over one or more file/path/glob tokens, not only those exact two files.",
      "Prefer readable regexes over exhaustive filename validation. Broad token patterns such as `[^\\s;&|><$`()'\"]+` are acceptable for path/glob-like arguments.",
      "Preserve the command/program structure and fixed flags/subcommands. Generalize only obvious input positions such as paths, globs, branch names, package names, URLs, search queries, test filters, and numeric limits.",
      "Avoid matching obvious shell-control syntax such as command separators, shell pipelines, command substitution, redirects, quotes, or newlines, but do not overfit. The user will review the suggestion before accepting it.",
      "The regex must be fully anchored with ^ and $, must match a single command line, and must not rely on flags.",
      "Use JavaScript/ECMAScript regex syntax. Do not include delimiters, flags, markdown, or explanation.",
      "Respond with ONLY the regex pattern as a single line of plain text.",
    ].join("\n");

    const userPrompt = [
      "Generate a limited-approval regex for this execute_command approval row.",
      "",
      "Full compound command:",
      args.fullCommand,
      "",
      "Sub-command this rule will match:",
      args.subCommand,
      "",
      "Return one anchored JavaScript regex pattern that matches the sub-command and useful variants with the same command shape.",
    ].join("\n");

    const result = await provider.complete({
      model,
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 512,
      temperature: 0,
      reasoningEffort: "none",
    });

    const pattern = extractRegexPattern(result.text);
    if (!pattern) {
      throw new Error("Model returned no usable regex");
    }
    validateSuggestedCommandRegex(pattern, args.subCommand);
    return pattern;
  }

  private async handleSuggestRegex(args: {
    requestId: string;
    subCommand: string;
    fullCommand: string;
  }): Promise<void> {
    try {
      const pattern = await this.suggestRegexForCommand({
        subCommand: args.subCommand,
        fullCommand: args.fullCommand,
      });
      this.postMessage({
        type: "regexSuggestion",
        requestId: args.requestId,
        pattern,
      } as ExtensionToWebview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[suggest-regex] failed: ${message}`);
      this.postMessage({
        type: "regexSuggestion",
        requestId: args.requestId,
        error: message,
      } as ExtensionToWebview);
    }
  }

  /**
   * Show a rich approval card in the chat webview.
   * All approvals are routed through the rich card system (WriteCard,
   * CommandCard, McpCard, ModeSwitchCard) with follow-up input and
   * rejection reasons.
   */
  public requestApproval(
    request: {
      kind: "mcp" | "write" | "rename" | "command" | "mode-switch" | "memory";
      title: string;
      detail?: string;
      choices: Array<{
        label: string;
        value: string;
        isPrimary?: boolean;
        isDanger?: boolean;
      }>;
      id?: string;
      backgroundTask?: string;
    },
    sessionId?: string,
  ): Promise<
    | string
    | {
        decision: string;
        rejectionReason?: string;
        followUp?: string;
        trustScope?: string;
        rulePattern?: string;
        ruleMode?: string;
        editedContent?: string;
        memoryTier?: import("../approvals/webview/types.js").MemoryTier;
        memoryScope?: import("../approvals/webview/types.js").MemoryScope;
        memoryName?: string;
      }
  > {
    const id = request.id ?? randomUUID();

    // Build an ApprovalRequest for the rich card system
    const approvalRequest = this.buildApprovalRequest(id, request);

    if (sessionId) {
      const sessionSet = this.approvalSessionIndex.get(sessionId) ?? new Set();
      sessionSet.add(id);
      this.approvalSessionIndex.set(sessionId, sessionSet);
    }

    return new Promise((resolve) => {
      this.pendingApprovals.set(id, (result) => {
        this.clearApprovalRequest(id);
        if (sessionId) {
          this.approvalSessionIndex.get(sessionId)?.delete(id);
        }
        resolve(result);
      });
      this.showApprovalRequest(approvalRequest);
    });
  }

  /**
   * Map an inline approval request to a rich ApprovalRequest for the card system.
   */
  private buildApprovalRequest(
    id: string,
    request: {
      kind: string;
      title: string;
      detail?: string;
      choices: Array<{
        label: string;
        value: string;
        isPrimary?: boolean;
        isDanger?: boolean;
      }>;
    },
  ): ApprovalRequest {
    switch (request.kind) {
      case "write": {
        const pathMatch = request.title.match(/`([^`]+)`/);
        const filePath = pathMatch?.[1] ?? request.title;
        const isCreate = request.title.startsWith("Create");
        return {
          kind: "write",
          id,
          filePath,
          writeOperation: isCreate ? "create" : "modify",
          detail: request.detail,
        };
      }
      case "rename": {
        const renameMatch = request.title.match(
          /`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/,
        );

        let oldName = renameMatch?.[1];
        let newName = renameMatch?.[2];

        if (!oldName || !newName) {
          const simplified = request.title
            .replace(/^Rename\s+/i, "")
            .replace(/\?$/, "");
          const arrow = simplified.includes("→")
            ? "→"
            : simplified.includes("->")
              ? "->"
              : undefined;
          if (arrow) {
            const [left, right] = simplified.split(arrow, 2);
            oldName = oldName ?? left.replace(/`/g, "").trim();
            newName = newName ?? right.replace(/`/g, "").trim();
          }
        }

        const affectedFiles: Array<{ path: string; changes: number }> = [];
        const detail = request.detail ?? "";
        const firstLine = detail.split("\n", 1)[0] ?? "";
        const totalChangesMatch = firstLine.match(
          /(\d+)\s+(?:change|changes|match|matches)/i,
        );
        const totalChanges = totalChangesMatch
          ? Number.parseInt(totalChangesMatch[1], 10)
          : undefined;

        const lines = detail.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const fileMatch = trimmed.match(
            /^(.+?)\s+\((\d+)\s+(?:change|changes|match|matches)\)$/i,
          );
          if (!fileMatch) continue;
          affectedFiles.push({
            path: fileMatch[1],
            changes: Number.parseInt(fileMatch[2], 10),
          });
        }

        return {
          kind: "rename",
          id,
          oldName,
          newName,
          affectedFiles,
          totalChanges,
        };
      }
      case "mcp":
        return {
          kind: "mcp",
          id,
          command: request.title,
          mcpDetail: request.detail,
          mcpChoices: request.choices,
        };
      case "mode-switch":
        return {
          kind: "mode-switch",
          id,
          command: request.title,
          mcpDetail: request.detail,
        };
      case "memory":
        return {
          kind: "memory",
          id,
          command: request.title,
          mcpDetail: request.detail,
        };
      default:
        return {
          kind: request.kind as ApprovalRequest["kind"],
          id,
          command: request.detail ?? request.title,
          subCommands: [],
        };
    }
  }

  /**
   * Ask the user a set of questions via the chat webview and wait for responses.
   * Called by the ask_user tool handler in toolAdapter.
   */
  public requestQuestion(
    context: string,
    questions: import("./webview/types.js").Question[],
    sessionId: string,
    backgroundTask?: string,
  ): Promise<import("./toolAdapter.js").QuestionResponse> {
    const { randomUUID } = require("crypto") as typeof import("crypto");
    const id = randomUUID();
    // Register in the session index so agentStop can cancel only this session's questions
    const sessionSet = this.questionSessionIndex.get(sessionId) ?? new Set();
    sessionSet.add(id);
    this.questionSessionIndex.set(sessionId, sessionSet);
    return new Promise((resolve) => {
      this.pendingQuestions.set(id, (raw) => {
        this.questionSessionIndex.get(sessionId)?.delete(id);
        resolve({
          answers:
            raw.answers as import("./toolAdapter.js").QuestionResponse["answers"],
          notes: (raw.notes as Record<string, string>) ?? {},
        });
      });
      this.uiPublisher.publishQuestionRequest(
        id,
        context,
        questions,
        backgroundTask,
      );
    });
  }

  public submitBrowserApprovalDecision(msg: {
    id: string;
    decision?: string;
    editedCommand?: string;
    rejectionReason?: string;
    rulePattern?: string;
    ruleMode?: string;
    rules?: Array<{ pattern: string; mode: string; scope: string }>;
    trustScope?: string;
    editedContent?: string;
    memoryTier?: import("../approvals/webview/types.js").MemoryTier;
    memoryScope?: import("../approvals/webview/types.js").MemoryScope;
    memoryName?: string;
    followUp?: string;
  }): boolean {
    const id = msg.id;
    const resolveInline = this.pendingApprovals.get(id);
    if (resolveInline) {
      this.pendingApprovals.delete(id);
      resolveInline({
        decision: String(msg.decision ?? "reject"),
        rejectionReason: msg.rejectionReason ?? undefined,
        followUp: msg.followUp ?? undefined,
        trustScope: msg.trustScope ?? undefined,
        rulePattern: msg.rulePattern ?? undefined,
        ruleMode: msg.ruleMode ?? undefined,
        editedContent: msg.editedContent ?? undefined,
        memoryTier: msg.memoryTier ?? undefined,
        memoryScope: msg.memoryScope ?? undefined,
        memoryName: msg.memoryName ?? undefined,
      });
      return true;
    }

    const respond = this.pendingForwardedApprovals.get(id);
    if (!respond) return false;
    this.pendingForwardedApprovals.delete(id);
    this.clearApprovalRequest(id);
    const decision: DecisionMessage = {
      type: "decision",
      id,
      decision: String(msg.decision ?? "reject"),
      editedCommand: msg.editedCommand ?? undefined,
      rejectionReason: msg.rejectionReason ?? undefined,
      rulePattern: msg.rulePattern ?? undefined,
      ruleMode: msg.ruleMode ?? undefined,
      rules: msg.rules as DecisionMessage["rules"],
      trustScope: msg.trustScope ?? undefined,
      editedContent: msg.editedContent ?? undefined,
      memoryTier: msg.memoryTier ?? undefined,
      memoryScope: msg.memoryScope ?? undefined,
      memoryName: msg.memoryName ?? undefined,
      followUp: msg.followUp ?? undefined,
    };
    respond(decision);
    return true;
  }

  public submitBrowserQuestionResponse(msg: {
    id: string;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes?: Record<string, string>;
  }): boolean {
    const resolve = this.pendingQuestions.get(msg.id);
    if (!resolve) return false;
    this.pendingQuestions.delete(msg.id);
    resolve({
      answers: msg.answers,
      notes: msg.notes ?? {},
    });
    this.applyProjectedAction({ type: "CLEAR_QUESTION" });
    this.uiPublisher.publishQuestionCleared(msg.id);
    return true;
  }

  public publishBrowserQuestionProgress(progress: {
    id: string;
    step: number;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes: Record<string, string>;
    origin: string;
  }): boolean {
    if (!this.pendingQuestions.has(progress.id)) return false;
    this.uiPublisher.publishQuestionProgress(progress);
    return true;
  }

  public submitBrowserUrlElicitation(msg: {
    id: string;
    action: "accept" | "cancel" | "decline";
  }): boolean {
    return this.resolveUrlElicitation(msg.id, msg.action);
  }

  private resolveUrlElicitation(
    id: string,
    action: "accept" | "cancel" | "decline",
  ): boolean {
    const pending = this.pendingUrlElicitations.get(id);
    if (!pending) return false;
    this.pendingUrlElicitations.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.resolve(action);
    this.uiPublisher.publishUrlElicitationCleared(id);
    return true;
  }

  private cancelPendingUrlElicitations(): void {
    for (const [id, pending] of this.pendingUrlElicitations) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve("cancel");
      this.uiPublisher.publishUrlElicitationCleared(id);
    }
    this.pendingUrlElicitations.clear();
  }

  private clearUrlElicitation(id: string): boolean {
    const pending = this.pendingUrlElicitations.get(id);
    if (!pending) return false;
    this.pendingUrlElicitations.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    this.uiPublisher.publishUrlElicitationCleared(id);
    return true;
  }

  public async submitBrowserSend(input: {
    text: string;
    id?: string;
    mode?: string;
    sessionId?: string;
    thinkingEnabled?: boolean;
    reasoningEffort?: import("./providers/types.js").ReasoningEffort;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
    displayText?: string;
    slashCommandLabel?: string;
    isSlashCommand?: boolean;
  }): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
    const text = input.text;
    const mode = input.mode ?? "code";
    const sessionId = input.sessionId;
    const reasoningEffort =
      input.reasoningEffort ??
      (input.thinkingEnabled === false ? "none" : undefined);
    const thinkingEnabled = reasoningEffort
      ? reasoningEffort !== "none"
      : input.thinkingEnabled !== false;
    const attachments = input.attachments ?? [];
    const images = input.images ?? [];
    const documents = input.documents ?? [];
    const displayText = input.displayText;
    const isSlashCommand = input.isSlashCommand === true;
    const slashCommandLabel = input.slashCommandLabel;

    if (
      !text?.trim() &&
      attachments.length === 0 &&
      images.length === 0 &&
      documents.length === 0
    ) {
      return { ok: false };
    }

    const resolvedText = await this.resolveAttachments(text, attachments);
    const mgr = this.sessionManager;
    if (!mgr) return { ok: false };
    let effectiveSessionId = sessionId;

    if (!effectiveSessionId || !mgr.getSession(effectiveSessionId)) {
      const newSession = await mgr.createSession(mode, {
        activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
      });
      effectiveSessionId = newSession.id;
      this.approvalManager?.migrateSessionState("agent", effectiveSessionId);
    }

    const effectiveSession = mgr.getSession(effectiveSessionId);
    const isActiveSession =
      effectiveSession?.status === "streaming" ||
      effectiveSession?.status === "tool_executing" ||
      effectiveSession?.status === "awaiting_approval";

    if (effectiveSession && isActiveSession) {
      const foregroundSession = mgr.getForegroundSession();
      if (foregroundSession?.id !== effectiveSession.id) {
        return { ok: false, error: "session_not_foreground" };
      }
      this.ensureProjectedForegroundSession(foregroundSession);
      if (this.projectedForegroundState.messageQueue.length > 0) {
        return { ok: false, error: "queue_full" };
      }

      const queueId = randomUUID();
      const displayQueueText = displayText ?? text;
      const displayMedia = mediaToDisplayMedia({ images, documents });
      const queued = effectiveSession.setPendingInterjection(
        resolvedText,
        queueId,
        input.id,
        displayQueueText,
        isSlashCommand,
        slashCommandLabel,
        undefined,
        images.length > 0 ? images : undefined,
        documents.length > 0 ? documents : undefined,
      );
      if (!queued) {
        return { ok: false, error: "queue_full" };
      }

      this.postMessage({
        type: "agentQueuedMessage",
        sessionId: effectiveSessionId,
        queueId,
        text: resolvedText,
        displayText: displayQueueText,
        isSlashCommand,
        slashCommandLabel,
        attachments: attachments.length > 0 ? attachments : undefined,
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
        displayMedia,
        source: "browser",
      });
      return { ok: true, queued: true };
    }

    this.postMessage({
      type: "agentCommittedUserMessage",
      sessionId: effectiveSessionId,
      id: input.id,
      text: resolvedText,
      displayText: displayText ?? text,
      isSlashCommand,
      slashCommandLabel,
      origin: "browser",
      displayMedia: mediaToDisplayMedia({ images, documents }),
    });

    mgr
      .sendMessage(effectiveSessionId, resolvedText, mode, {
        thinkingEnabled,
        reasoningEffort,
        activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
        displayText: displayText ?? text,
        isSlashCommand,
        slashCommandLabel,
        origin: "browser",
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
      })
      .catch((err) => {
        this.log(`[error] browser send failed: ${err}`);
      });

    const fg = mgr.getForegroundSession();
    if (fg) {
      const condenseThreshold = this.getConfiguredCondenseThreshold(fg.model);
      this.postMessage({
        type: "stateUpdate",
        state: {
          sessionId: fg.id,
          mode: fg.mode,
          model: fg.model,
          streaming: true,
          condenseThreshold,
          contextBudget: this.buildContextBudget(
            fg,
            fg.model,
            condenseThreshold,
          ),
          agentWriteApproval: this.approvalManager?.getAgentWriteApprovalState(
            fg.id,
          ),
        },
      });
    }

    return { ok: true };
  }

  public async submitBrowserModeSwitch(mode: string): Promise<{
    approved: boolean;
    mode: string;
  }> {
    const fg = this.sessionManager?.getForegroundSession();
    if (fg && fg.mode !== mode) {
      try {
        const session = await this.sessionManager?.switchForegroundMode(mode);
        if (!session && this.sessionManager) {
          await this.sessionManager.createSession(mode);
        } else if (session) {
          this.approvalManager?.resetSessionAgentWriteApproval(session.id);
        }
        this.sendInitialState();
        this.log(`[mode] browser switched mode to ${mode}`);
        return { approved: true, mode };
      } catch (err) {
        this.log(`[mode] browser failed to switch mode: ${err}`);
        return { approved: false, mode };
      }
    }

    if (!fg && this.sessionManager) {
      await this.sessionManager.createSession(mode);
      this.sendInitialState();
      this.log(`[mode] browser created new session in mode ${mode}`);
      return { approved: true, mode };
    }

    return { approved: true, mode };
  }

  public async submitBrowserSetModel(model: string): Promise<{ ok: boolean }> {
    if (!model || !this.sessionManager) return { ok: false };
    await this.sessionManager.setModel(model);

    const config = vscode.workspace.getConfiguration("agentlink");
    await config.update("agentModel", model, vscode.ConfigurationTarget.Global);

    const fgMode = this.sessionManager.getForegroundSession()?.mode ?? "code";
    const modePrefs = getModeModelPreferences(config);
    await config.update(
      "modeModelPreferences",
      {
        ...modePrefs,
        [fgMode]: model,
      },
      vscode.ConfigurationTarget.Global,
    );

    this.sendInitialState();
    this.log(`Model changed to: ${model} (saved for mode: ${fgMode})`);
    return { ok: true };
  }

  public submitBrowserSetWriteApproval(mode: string): { ok: boolean } {
    if (!mode || !this.approvalManager) return { ok: false };

    const fgSession = this.sessionManager?.getForegroundSession();
    const fgSessionId = fgSession?.id ?? "agent";
    this.approvalManager.resetAgentWriteApproval();
    if (mode !== "prompt") {
      this.approvalManager.setAgentWriteApproval(
        fgSessionId,
        mode as "session" | "project" | "global",
      );
    }

    this.sendInitialState();
    this.log(`Agent write approval changed to: ${mode}`);
    return { ok: true };
  }

  public getBrowserThinkingEnabledState(): boolean {
    const fg = this.sessionManager?.getForegroundSession();
    if (!fg) return true;
    return fg.reasoningEffort !== "none";
  }

  public getBrowserReasoningEffortState(): import("./providers/types.js").ReasoningEffort {
    const fg = this.sessionManager?.getForegroundSession();
    return fg?.reasoningEffort ?? "high";
  }

  public submitBrowserSetThinkingEnabled(enabled: boolean): { ok: boolean } {
    return this.submitBrowserSetReasoningEffort(enabled ? "high" : "none");
  }

  public submitBrowserSetReasoningEffort(
    effort: import("./providers/types.js").ReasoningEffort,
  ): { ok: boolean } {
    const fg = this.sessionManager?.getForegroundSession();
    if (!fg || !this.sessionManager) return { ok: false };
    fg.reasoningEffort = effort;
    if (effort === "none") {
      fg.thinkingBudget = 0;
    } else if (fg.thinkingBudget === 0) {
      fg.thinkingBudget = this.sessionManager.getConfig().thinkingBudget;
    }
    this.sendInitialState();
    this.log(`Reasoning effort changed: ${effort}`);
    return { ok: true };
  }

  public async submitBrowserNewSession(
    mode?: string,
  ): Promise<{ ok: boolean }> {
    if (!this.sessionManager) return { ok: false };
    const nextMode = mode?.trim() || "code";
    const session = await this.sessionManager.createSession(nextMode);
    this.postSessionLoaded(session, {
      checkpoints: this.getSessionCheckpoints(session.id),
      tailTurns: 0,
    });
    this.sendInitialState();
    this.log(
      `New session created from browser (${nextMode}, model: ${session.model})`,
    );
    return { ok: true };
  }

  public submitBrowserListSessions(): {
    ok: boolean;
    sessions: SessionSummary[];
  } {
    if (!this.sessionManager) return { ok: false, sessions: [] };
    return {
      ok: true,
      sessions: this.sessionManager.listPersistedSessions(),
    };
  }

  public async submitBrowserLoadSession(
    sessionId: string,
  ): Promise<{ ok: boolean }> {
    if (!sessionId || !this.sessionManager) return { ok: false };
    const session = await this.sessionManager.loadPersistedSession(sessionId);
    if (!session) {
      this.log(`[history] session not found: ${sessionId}`);
      return { ok: false };
    }
    this.postSessionLoaded(session, {
      checkpoints: this.getSessionCheckpoints(session.id),
    });
    this.sendInitialState();
    return { ok: true };
  }

  public async submitBrowserDeleteSession(
    sessionId: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (!sessionId) {
      return {
        ok: false,
        message: "Could not delete the session: missing session id.",
      };
    }
    if (!this.sessionManager) {
      return {
        ok: false,
        message:
          "Could not delete the session: session manager is not available.",
      };
    }
    const result =
      await this.sessionManager.deletePersistedSessionWithResult(sessionId);
    if (!result.ok) {
      const message = formatPersistedSessionMutationFailureMessage(result);
      this.log(`[history] ${message}`);
      return { ok: false, message };
    }
    this.approvalManager?.clearSession(sessionId);
    this.sendSessionList();
    return { ok: true };
  }

  public async submitBrowserRenameSession(
    sessionId: string,
    title: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (!sessionId) {
      return {
        ok: false,
        message: "Could not rename the session: missing session id.",
      };
    }
    if (!title) {
      return {
        ok: false,
        message: "Could not rename the session: title is required.",
      };
    }
    if (!this.sessionManager) {
      return {
        ok: false,
        message:
          "Could not rename the session: session manager is not available.",
      };
    }
    const result = await this.sessionManager.renamePersistedSessionWithResult(
      sessionId,
      title,
    );
    if (!result.ok) {
      const message = formatPersistedSessionMutationFailureMessage(result);
      this.log(`[history] ${message}`);
      return { ok: false, message };
    }
    this.sendSessionList();
    return { ok: true };
  }

  public submitBrowserCopyFirstPrompt(sessionId: string): {
    ok: boolean;
    prompt?: string;
  } {
    if (!sessionId || !this.sessionManager) return { ok: false };
    const prompt = this.sessionManager.loadFirstPrompt(sessionId);
    if (!prompt) return { ok: false };
    return { ok: true, prompt };
  }

  public async submitBrowserRefreshDebugInfo(): Promise<{
    ok: boolean;
    info?: Record<string, string | number>;
    systemPrompt?: string;
    loadedInstructions?: LoadedInstructionDebugInfo[];
  }> {
    const os = require("os");

    const info: Record<string, string | number> = {
      "vscode.sessionId": vscode.env.sessionId,
      "vscode.machineId": vscode.env.machineId,
      "vscode.appName": vscode.env.appName,
      "vscode.appHost": vscode.env.appHost,
      "vscode.language": vscode.env.language,
      "vscode.uiKind":
        vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web",
      "vscode.remoteName": vscode.env.remoteName ?? "none",
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      uptime: `${Math.round(process.uptime())}s`,
      workspaceFolders:
        (vscode.workspace.workspaceFolders ?? [])
          .map((f: vscode.WorkspaceFolder) => f.uri.fsPath)
          .join(", ") || "none",
    };

    const sensitiveKeys = /key|token|secret|password|auth|credential/i;
    const envEntries = Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of envEntries) {
      const displayValue = sensitiveKeys.test(key)
        ? `${value!.slice(0, 8)}...`
        : value!;
      info[`env.${key}`] = displayValue;
    }

    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const fg = this.sessionManager?.getForegroundSession();
    let systemPrompt = fg?.systemPrompt;
    if (!systemPrompt && this.cwd) {
      try {
        const mode = fg?.mode ?? "code";
        const model = fg?.model ?? this.sessionManager?.getConfig().model;
        const providerId = model
          ? providerRegistry.tryResolveProvider(model)?.id
          : undefined;
        systemPrompt = await buildSystemPrompt(mode, this.cwd, {
          providerId,
          activeFilePath,
          workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
            (f) => ({ name: f.name, path: f.uri.fsPath }),
          ),
        });
      } catch (err) {
        this.log(`[warn] Failed to build debug system prompt: ${err}`);
      }
    }

    let loadedInstructions: LoadedInstructionDebugInfo[] | undefined;
    if (this.cwd) {
      try {
        const blocks = await loadAllInstructionBlocks(this.cwd, {
          activeFilePath,
        });
        loadedInstructions = blocks.map((block) =>
          formatInstructionDebugInfo(block, this.cwd, activeFilePath),
        );
      } catch (err) {
        this.log(`[warn] Failed to load instruction blocks for debug: ${err}`);
      }
    }

    const bgRouting = this.sessionManager?.getRecentBgRoutingSummaries(5) ?? [];
    if (bgRouting.length > 0) {
      bgRouting.forEach((line, idx) => {
        info[`bg.route.${idx + 1}`] = line;
      });
    }

    if (fg) {
      this.ensureProjectedForegroundSession(fg);
      this.projectedForegroundState = {
        ...this.projectedForegroundState,
        debugInfo: { ...info },
        systemPrompt: systemPrompt ?? null,
        loadedInstructions: loadedInstructions
          ? loadedInstructions.map((item) => ({ ...item }))
          : null,
      };
    }

    return {
      ok: true,
      info,
      systemPrompt: systemPrompt ?? undefined,
      loadedInstructions,
    };
  }

  public submitBrowserMcpAction(
    serverName: string,
    action: "disable" | "reconnect" | "reauthenticate",
  ): {
    ok: boolean;
    infos?: ReturnType<McpClientHub["getServerInfos"]>;
  } {
    if (!serverName || !action) return { ok: false };
    void (async () => {
      if (action === "disable") {
        await this.mcpHub.disableServer(serverName);
      } else if (action === "reconnect") {
        await this.mcpHub.reconnectServer(serverName);
      } else if (action === "reauthenticate") {
        await this.mcpHub.reauthenticateServer(serverName);
      }
      this.postMessage({
        type: "agentMcpStatus",
        infos: this.mcpHub.getServerInfos(),
      } as ExtensionToWebview);
    })();
    return { ok: true, infos: this.mcpHub.getServerInfos() };
  }

  public async submitBrowserAttachFile(): Promise<{ files: string[] }> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: workspaceRoot,
      title: "Attach files to chat",
    });
    if (!uris?.length) {
      return { files: [] };
    }
    return {
      files: uris.map((u) => getRelativePath(u.fsPath)),
    };
  }

  /**
   * Stop a running session and clear any pending UI prompts (questions,
   * approvals, elicitations) that belong to it, then notify the webview so it
   * exits streaming state. Shared by the VS Code webview "agentStop" message
   * and the browser gateway stop endpoint.
   */
  private stopSessionFromUi(sessionId: string): void {
    if (!this.sessionManager) return;
    const session = this.sessionManager.getSession(sessionId);
    this.sessionManager.stopSession(sessionId);
    // Clear any active agent tool calls from the sidebar tracker
    this.toolCallTracker?.clearAgentCalls(sessionId);
    this.publishVisibleApprovalOrIdle();
    this.postMessage({
      type: "agentInteractionPromptsCleared",
      sessionId,
    });
    // Resolve only the pending questions belonging to this session so their
    // promises unblock without cancelling unrelated sessions' question flows.
    const questionIds = this.questionSessionIndex.get(sessionId);
    if (questionIds) {
      for (const id of questionIds) {
        const resolve = this.pendingQuestions.get(id);
        if (resolve) {
          this.pendingQuestions.delete(id);
          resolve({ answers: {}, notes: {} });
          this.uiPublisher.publishQuestionCleared(id);
        }
      }
      this.questionSessionIndex.delete(sessionId);
    }

    // Reject only the pending approvals belonging to this session.
    const approvalIds = this.approvalSessionIndex.get(sessionId);
    if (approvalIds) {
      for (const id of approvalIds) {
        const resolve = this.pendingApprovals.get(id);
        if (resolve) {
          this.pendingApprovals.delete(id);
          resolve("reject");
        } else {
          this.clearApprovalRequest(id);
        }
      }
      this.approvalSessionIndex.delete(sessionId);
    }

    // Cancel only the pending elicitation prompts belonging to this session.
    const elicitationIds = this.elicitationSessionIndex.get(sessionId);
    if (elicitationIds) {
      for (const id of elicitationIds) {
        const pending = this.pendingElicitations.get(id);
        if (pending) {
          this.pendingElicitations.delete(id);
          pending.cancel();
        }
      }
      this.elicitationSessionIndex.delete(sessionId);
    }
    // Immediately notify the webview so it exits streaming state
    this.postMessage({
      type: "agentDone",
      sessionId,
      totalInputTokens: session?.totalInputTokens ?? 0,
      totalOutputTokens: session?.totalOutputTokens ?? 0,
      totalCacheReadTokens: session?.totalCacheReadTokens ?? 0,
      totalCacheCreationTokens: session?.totalCacheCreationTokens ?? 0,
    });
    if (session?.background !== true) {
      this.drainBrowserQueuedInterjection(sessionId);
    }
    // If this was a bg session, push updated status so the strip/block
    // shows the cancelled state immediately.
    if (session?.background) {
      this.sendBgSessionsUpdate();
    }
  }

  /**
   * Stop the foreground/streaming session from the browser gateway. Mirrors the
   * VS Code webview's "agentStop" handling so the browser stop button works.
   */
  public submitBrowserStop(sessionId: string): { ok: boolean } {
    if (!sessionId || !this.sessionManager) return { ok: false };
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return { ok: false };
    this.stopSessionFromUi(sessionId);
    return { ok: true };
  }

  public submitBrowserStopBackground(sessionId: string): { ok: boolean } {
    if (!sessionId || !this.sessionManager) return { ok: false };
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.background) return { ok: false };
    this.sessionManager.killBackground(
      sessionId,
      "Stopped from browser gateway",
    );
    this.sendBgSessionsUpdate();
    return { ok: true };
  }

  public getBrowserBgTranscript(sessionId: string): {
    ok: boolean;
    transcript?: {
      sessionId: string;
      task: string;
      messages: unknown[];
    };
  } {
    if (!sessionId || !this.sessionManager) return { ok: false };
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.background) return { ok: false };
    return {
      ok: true,
      transcript: {
        sessionId,
        task: session.title ?? "Background Agent",
        messages: stripMediaForTransport(session.getAllMessages()),
      },
    };
  }

  public async getBrowserSlashCommands(): Promise<SlashCommandInfo[]> {
    await this.slashRegistry?.reload();
    return this.slashRegistry?.getAll() ?? [];
  }

  public async searchBrowserFiles(
    query: string,
  ): Promise<Array<{ path: string; kind: "file" | "folder" }>> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    if (!workspaceRoot) {
      return [];
    }

    try {
      const pattern = query === "*" ? "**/*" : `**/*${query}*`;
      const uris = await vscode.workspace.findFiles(
        pattern,
        "**/node_modules/**",
        50,
      );

      const files = uris.map((uri) => ({
        path: path.relative(workspaceRoot, uri.fsPath),
        kind: "file" as const,
      }));

      const lowerQuery = query.toLowerCase();
      files.sort((a, b) => {
        const aBase = path.basename(a.path).toLowerCase();
        const bBase = path.basename(b.path).toLowerCase();
        const aStarts = aBase.startsWith(lowerQuery) ? 0 : 1;
        const bStarts = bBase.startsWith(lowerQuery) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.path.length - b.path.length;
      });

      return files.slice(0, 20);
    } catch (err) {
      this.log(`[error] File search failed: ${err}`);
      return [];
    }
  }

  public async getBrowserModes(): Promise<
    Array<{ slug: string; name: string; icon: string }>
  > {
    const customModes = this.cwd ? await loadCustomModes(this.cwd) : [];
    const allModes = getAllModes(customModes);
    return allModes.map((m) => ({
      slug: m.slug,
      name: m.name,
      icon: m.icon,
    }));
  }

  public async getBrowserModels(): Promise<WebviewModelInfo[]> {
    const allModels = providerRegistry.listAllModels();
    const authStatus = await providerRegistry.getAuthStatus();
    return allModels.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      contextWindow: m.capabilities.contextWindow,
      maxInputTokens: m.capabilities.maxInputTokens,
      maxOutputTokens: m.capabilities.maxOutputTokens,
      reasoningEfforts: m.capabilities.reasoningEfforts,
      defaultReasoningEffort: m.capabilities.defaultReasoningEffort,
      authenticated: authStatus[m.provider] ?? false,
      condenseThreshold: this.getConfiguredCondenseThreshold(m.id),
    }));
  }

  private setupFileWatchers(cwd: string): void {
    // Watch .agentlink/ and .claude/ for config changes
    const configPattern = new vscode.RelativePattern(
      cwd,
      ".agentlink/{commands/**,modes.json,mcp.json}",
    );
    const configWatcher =
      vscode.workspace.createFileSystemWatcher(configPattern);
    const reloadConfig = () => {
      this.slashRegistry?.reload().then(() => this.sendSlashCommands());
      this.refreshMcpConnections({ interactiveForNewServers: true });
      void this.sendModesUpdate();
    };
    configWatcher.onDidChange(reloadConfig);
    configWatcher.onDidCreate(reloadConfig);
    configWatcher.onDidDelete(reloadConfig);
    this.fileWatchers.push(configWatcher);

    // Watch instruction files for system prompt hot-reload
    const instructionPattern = new vscode.RelativePattern(
      cwd,
      "{AGENTS.md,AGENT.md,CLAUDE.md,AGENTS.local.md,.claude/CLAUDE.md,.agentlink/CLAUDE.md,.agentlink/memory.md,.agents/rules/**/*.md,.agentlink/rules/**/*.md,.agentlink/rules-*/**/*.md,.agents/rules-*/**/*.md,**/AGENTS.md,**/AGENT.md,**/AGENTS.local.md}",
    );
    const instructionWatcher =
      vscode.workspace.createFileSystemWatcher(instructionPattern);
    const reloadInstructions = () => {
      void this.rebuildSessionSystemPrompts();
    };
    instructionWatcher.onDidChange(reloadInstructions);
    instructionWatcher.onDidCreate(reloadInstructions);
    instructionWatcher.onDidDelete(reloadInstructions);
    this.fileWatchers.push(instructionWatcher);
  }

  private async rebuildSessionSystemPrompts(): Promise<void> {
    if (!this.sessionManager) return;
    try {
      await this.sessionManager.rebuildSystemPrompts();
      this.log(
        "[instructions] Rebuilt system prompt after instruction file change",
      );
    } catch (err) {
      this.log(`[instructions] Failed to rebuild system prompt: ${err}`);
    }
  }

  private async sendModesUpdate(): Promise<void> {
    const customModes = this.cwd ? await loadCustomModes(this.cwd) : [];
    const allModes = getAllModes(customModes);
    const modes = allModes.map((m) => ({
      slug: m.slug,
      name: m.name,
      icon: m.icon,
    }));
    this.postMessage({ type: "agentModesUpdate", modes } as ExtensionToWebview);
  }

  private async sendModelsUpdate(): Promise<void> {
    // Lazy (non-blocking) dynamic model refresh — never on activation; runs once
    // per session, re-sends models + signals the browser when it lands (Target A).
    this.maybeRefreshAnthropicModels();
    const allModels = providerRegistry.listAllModels();
    const authStatus = await providerRegistry.getAuthStatus();
    const models = allModels.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      contextWindow: m.capabilities.contextWindow,
      maxInputTokens: m.capabilities.maxInputTokens,
      maxOutputTokens: m.capabilities.maxOutputTokens,
      reasoningEfforts: m.capabilities.reasoningEfforts,
      defaultReasoningEffort: m.capabilities.defaultReasoningEffort,
      authenticated: authStatus[m.provider] ?? false,
      condenseThreshold: this.getConfiguredCondenseThreshold(m.id),
    }));
    this.postMessage({
      type: "agentModelsUpdate",
      models,
    } as ExtensionToWebview);
  }

  private sendSlashCommands(): void {
    if (!this.slashRegistry) return;
    this.postMessage({
      type: "agentSlashCommandsUpdate",
      commands: this.slashRegistry.getAll(),
    } as ExtensionToWebview);
  }

  private sendSessionList(): void {
    const sessions = this.sessionManager?.listPersistedSessions() ?? [];
    this.postMessage({ type: "agentSessionList", sessions });
  }

  private getConfiguredCondenseThreshold(modelId: string): number {
    return getConfiguredBaseThresholdForModel(
      vscode.workspace.getConfiguration("agentlink"),
      modelId,
      providerRegistry.tryResolveProvider(modelId)?.getCapabilities(modelId),
    );
  }

  private buildContextBudget(
    session: AgentSession | undefined,
    modelId: string,
    condenseThreshold: number,
  ): ContextBudget | undefined {
    const provider = providerRegistry.tryResolveProvider(modelId);
    const caps = provider?.getCapabilities(modelId);
    if (!caps) return undefined;

    const config = this.sessionManager?.getConfig();
    const maxInputTokens =
      caps.maxInputTokens ??
      Math.max(0, caps.contextWindow - caps.maxOutputTokens);
    const outputReservation = Math.min(
      Math.max(
        session?.maxTokens ?? config?.maxTokens ?? 0,
        (session?.thinkingBudget ?? config?.thinkingBudget ?? 0) + 4096,
      ),
      caps.maxOutputTokens,
    );
    const safetyBufferTokens = Math.floor(maxInputTokens * 0.05);

    return {
      contextWindow: caps.contextWindow,
      maxInputTokens,
      usedInputTokens: session?.estimatedInputUsed ?? 0,
      outputReservation,
      safetyBufferTokens,
      softThresholdBudget: Math.floor(maxInputTokens * condenseThreshold),
      hardBudget: Math.max(0, maxInputTokens - safetyBufferTokens),
    };
  }

  log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  setSessionManager(manager: AgentSessionManager): void {
    this.sessionManager = manager;
    this.slashRegistry?.setMode(manager.getForegroundSession()?.mode ?? "code");
    void this.slashRegistry?.reload().then(() => this.sendSlashCommands());

    manager.onEvent = (sessionId, event) => {
      this.handleAgentEvent(sessionId, event);
    };

    manager.onSessionsChanged = () => {
      // Session status can change outside the foreground event stream (for example
      // when a tracked tool is force-cancelled/completed from the sidebar). Push a
      // full foreground state refresh so the chat webview's streaming/session state
      // stays aligned with the real session status, then refresh the sidebar strips.
      this.slashRegistry?.setMode(
        manager.getForegroundSession()?.mode ?? "code",
      );
      void this.slashRegistry?.reload().then(() => this.sendSlashCommands());
      this.sendInitialState();
      this.sendBgSessionsUpdate();
    };
  }

  private sendBgSessionsUpdate(): void {
    if (!this.sessionManager) return;
    this.postMessage({
      type: "agentBgSessionsUpdate",
      sessions: this.sessionManager.getBgSessionInfos(),
    });
  }

  /**
   * Throttled version of sendBgSessionsUpdate for high-frequency events
   * (text_delta). Coalesces updates to fire at most once per 150ms.
   */
  private sendBgSessionsUpdateThrottled(): void {
    if (this.bgUpdateTimer) return; // already scheduled
    this.bgUpdateTimer = setTimeout(() => {
      this.bgUpdateTimer = null;
      this.sendBgSessionsUpdate();
    }, 150);
  }

  /**
   * Flush all buffered streaming deltas to the webview immediately.
   * Called on a timer (scheduleDeltaFlush) and synchronously before done/error.
   */
  private flushDeltaBuffers(): void {
    this.deltaFlushTimer = null;
    for (const [sessionId, text] of this.textDeltaBuffer) {
      this.postMessage({ type: "agentTextDelta", sessionId, text });
    }
    this.textDeltaBuffer.clear();
    for (const [sessionId, byId] of this.thinkingDeltaBuffer) {
      for (const [thinkingId, text] of byId) {
        this.postMessage({
          type: "agentThinkingDelta",
          sessionId,
          thinkingId,
          text,
        });
      }
    }
    this.thinkingDeltaBuffer.clear();
    for (const [sessionId, byId] of this.toolInputDeltaBuffer) {
      const isBackground = Boolean(
        this.sessionManager?.getSession(sessionId)?.background,
      );
      for (const [toolCallId, partialJson] of byId) {
        this.postMessage({
          type: isBackground ? "agentBgToolInputDelta" : "agentToolInputDelta",
          sessionId,
          toolCallId,
          partialJson,
        });
      }
    }
    this.toolInputDeltaBuffer.clear();
  }

  /** Schedule a delta flush ~16ms from now (idempotent). */
  private scheduleDeltaFlush(): void {
    if (this.deltaFlushTimer !== null) return;
    this.deltaFlushTimer = setTimeout(() => this.flushDeltaBuffers(), 16);
  }

  /** Cancel any pending flush timer and drain buffers immediately. */
  private flushDeltaBuffersNow(): void {
    if (this.deltaFlushTimer !== null) {
      clearTimeout(this.deltaFlushTimer);
    }
    this.flushDeltaBuffers();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webviewView.webview.html = this.getHtml();
    this.webviewReady = false;

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendInitialState();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });
  }

  private async handleWebviewMessage(
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (msg.command) {
      case "agentStreamDrop": {
        if (!__DEV_BUILD__) break;
        const reason = String(msg.reason ?? "");
        const eventType = String(msg.eventType ?? "unknown");
        const eventSessionId =
          msg.eventSessionId === null || msg.eventSessionId === undefined
            ? "none"
            : String(msg.eventSessionId);
        const currentSessionId =
          msg.currentSessionId === null || msg.currentSessionId === undefined
            ? "none"
            : String(msg.currentSessionId);
        const streaming = Boolean(msg.streaming);

        if (reason === "session_mismatch") {
          this.streamDropCounts.sessionMismatch += 1;
        } else if (reason === "streaming_false") {
          this.streamDropCounts.streamingFalse += 1;
        }

        if (!this.streamDropLogTimer) {
          this.streamDropLogTimer = setTimeout(() => {
            this.streamDropLogTimer = null;
            this.log(
              `[webview-drop] summary: session_mismatch=${this.streamDropCounts.sessionMismatch} streaming_false=${this.streamDropCounts.streamingFalse}`,
            );
          }, 2000);
        }

        this.log(
          `[webview-drop] reason=${reason} event=${eventType} eventSession=${eventSessionId} currentSession=${currentSessionId} streaming=${streaming}`,
        );
        break;
      }
      case "webviewReady":
        this.webviewReady = true;
        void this.sendModesUpdate();
        void this.sendModelsUpdate();
        this.sendSlashCommands();
        this.sendSessionList();
        // Flush any messages queued before the webview was ready. Use the same
        // guarded send path as live messages so a reload/crash during replay does
        // not silently drop transcript events.
        this.flushPendingWebviewMessages();
        // Restore last session if there is no foreground session yet
        if (!this.sessionManager?.getForegroundSession()) {
          this.postMessage({ type: "agentRestoreSessionStart" });
          this.sessionManager
            ?.restoreLastSession()
            .then((session) => {
              if (session) {
                this.postSessionLoaded(session, {
                  restored: true,
                  checkpoints: this.getSessionCheckpoints(session.id),
                });
              }
              this.postMessage({ type: "agentRestoreSessionDone" });
              this.sendInitialState();
              void this.sendDebugInfo();
            })
            .catch(() => {
              this.postMessage({ type: "agentRestoreSessionDone" });
              this.sendInitialState();
              void this.sendDebugInfo();
            });
        } else {
          const fg = this.sessionManager.getForegroundSession();
          if (fg) {
            this.postSessionLoaded(fg, {
              checkpoints: this.getSessionCheckpoints(fg.id),
            });
          }
          this.sendInitialState();
          void this.sendDebugInfo();
        }
        break;

      case "themeSnapshot": {
        const parsed = this.parseThemeSnapshot(msg);
        if (parsed) {
          this.browserGatewayThemeSnapshot = parsed;
        }
        break;
      }

      case "agentSend": {
        const text = msg.text as string;
        const mode = (msg.mode as string) ?? "code";
        this.applyProjectedAction({
          type: "ADD_USER_MESSAGE",
          text: (msg.displayText as string | undefined) ?? text,
          isSlashCommand: msg.isSlashCommand === true,
          slashCommandLabel: msg.slashCommandLabel as string | undefined,
        });
        const sessionId = msg.sessionId as string | undefined;
        const reasoningEffort =
          (msg.reasoningEffort as
            | import("./providers/types.js").ReasoningEffort
            | undefined) ??
          (msg.thinkingEnabled === false ? "none" : undefined);
        const thinkingEnabled = reasoningEffort
          ? reasoningEffort !== "none"
          : msg.thinkingEnabled !== false;
        const displayText = msg.displayText as string | undefined;
        const isSlashCommand = msg.isSlashCommand === true;
        const slashCommandLabel = msg.slashCommandLabel as string | undefined;
        const attachments = (msg.attachments as string[]) ?? [];
        const images =
          (msg.images as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        const documents =
          (msg.documents as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];

        if (
          !text?.trim() &&
          attachments.length === 0 &&
          images.length === 0 &&
          documents.length === 0
        )
          return;

        const resolvedText = await this.resolveAttachments(text, attachments);

        this.log(
          `[send] session=${sessionId ?? "new"} mode=${mode} reasoning=${reasoningEffort ?? (thinkingEnabled ? "default" : "none")} attachments=${attachments.length} images=${images.length} documents=${documents.length} text="${resolvedText.slice(0, 80)}${resolvedText.length > 80 ? "..." : ""}"`,
        );
        if (images.length > 0) {
          for (const img of images) {
            this.log(
              `[send:image] name="${img.name}" mimeType="${img.mimeType}" base64Length=${img.base64?.length ?? 0}`,
            );
          }
        }

        const mgr = this.sessionManager;
        let effectiveSessionId = sessionId;
        if (!effectiveSessionId || !mgr.getSession(effectiveSessionId)) {
          const newSession = await mgr.createSession(mode, {
            activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
          });
          effectiveSessionId = newSession.id;
          this.approvalManager?.migrateSessionState(
            "agent",
            effectiveSessionId,
          );
        }

        mgr
          .sendMessage(effectiveSessionId, resolvedText, mode, {
            thinkingEnabled,
            reasoningEffort,
            activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
            displayText,
            isSlashCommand,
            slashCommandLabel,
            origin: "vscode",
            images: images.length > 0 ? images : undefined,
            documents: documents.length > 0 ? documents : undefined,
          })
          .catch((err) => {
            this.log(`[error] send failed: ${err}`);
          });

        const fg = mgr.getForegroundSession();
        if (fg) {
          const condenseThreshold = this.getConfiguredCondenseThreshold(
            fg.model,
          );
          this.postMessage({
            type: "stateUpdate",
            state: {
              sessionId: fg.id,
              mode: fg.mode,
              model: fg.model,
              streaming: true,
              condenseThreshold,
              contextBudget: this.buildContextBudget(
                fg,
                fg.model,
                condenseThreshold,
              ),
              agentWriteApproval:
                this.approvalManager?.getAgentWriteApprovalState(fg.id),
            },
          });
        }
        break;
      }

      case "agentStop": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          this.stopSessionFromUi(sessionId);
        }
        break;
      }

      case "agentRetry": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          this.log(`[retry] retrying session ${sessionId}`);
          this.applyProjectedAction({ type: "CLEAR_ERROR" });
          this.sessionManager.retrySession(sessionId).catch((err) => {
            this.log(`[error] retry failed: ${err}`);
          });
          // Update state to show streaming
          const fg = this.sessionManager.getForegroundSession();
          if (fg) {
            const condenseThreshold = this.getConfiguredCondenseThreshold(
              fg.model,
            );
            this.postMessage({
              type: "stateUpdate",
              state: {
                sessionId: fg.id,
                mode: fg.mode,
                model: fg.model,
                streaming: true,
                condenseThreshold,
                contextBudget: this.buildContextBudget(
                  fg,
                  fg.model,
                  condenseThreshold,
                ),
                agentWriteApproval:
                  this.approvalManager?.getAgentWriteApprovalState(fg.id),
              },
            });
          }
        }
        break;
      }

      case "agentNewSession": {
        const mode = (msg.mode as string) ?? "code";
        this.sessionManager.createSession(mode).then((session) => {
          this.postSessionLoaded(session, {
            checkpoints: this.getSessionCheckpoints(session.id),
            tailTurns: 0,
          });
          this.sendInitialState();
          this.log(
            `New session created: ${session.id} (model: ${session.model})`,
          );
        });
        break;
      }

      case "agentSwitchMode": {
        const mode = (msg.mode as string) ?? "code";
        this.slashRegistry?.setMode(mode);
        const fg = this.sessionManager.getForegroundSession();
        if (fg && fg.mode !== mode) {
          this.sessionManager
            .switchForegroundMode(mode)
            .then((session) => {
              if (!session) {
                // No active session — create a new one in the target mode
                return this.sessionManager!.createSession(mode);
              }
              this.approvalManager?.resetSessionAgentWriteApproval(session.id);
              return session;
            })
            .then(async () => {
              await this.slashRegistry?.reload();
              this.sendInitialState();
              this.sendSlashCommands();
              this.log(`[mode] user switched mode to ${mode}`);
            })
            .catch((err) => {
              this.log(`[mode] failed to switch mode: ${err}`);
            });
        } else if (!fg) {
          // No session yet — create one in the target mode
          this.sessionManager.createSession(mode).then(async () => {
            await this.slashRegistry?.reload();
            this.sendInitialState();
            this.sendSlashCommands();
            this.log(`[mode] new session created in mode ${mode}`);
          });
        }
        break;
      }

      case "agentClearSession": {
        // Create a fresh session with the same mode as the current one
        const fg = this.sessionManager.getForegroundSession();
        const mode = fg?.mode ?? "code";
        this.sessionManager.createSession(mode).then((session) => {
          this.postSessionLoaded(session, {
            checkpoints: this.getSessionCheckpoints(session.id),
            tailTurns: 0,
          });
          this.sendInitialState();
          this.log(`Session cleared, new session: ${session.id}`);
        });
        break;
      }

      case "agentSetModel": {
        const model = msg.model as string;
        if (!model) break;
        // Update config, session model, and rebuild system prompt if provider changed
        await this.sessionManager.setModel(model);
        // Persist to VS Code global settings so it survives restarts
        const config = vscode.workspace.getConfiguration("agentlink");
        await config.update(
          "agentModel",
          model,
          vscode.ConfigurationTarget.Global,
        );

        // Auto-save manual model changes as the default for the current mode.
        const fgMode =
          this.sessionManager.getForegroundSession()?.mode ?? "code";
        const modePrefs = getModeModelPreferences(config);
        await config.update(
          "modeModelPreferences",
          {
            ...modePrefs,
            [fgMode]: model,
          },
          vscode.ConfigurationTarget.Global,
        );

        this.sendInitialState();
        this.log(`Model changed to: ${model} (saved for mode: ${fgMode})`);
        break;
      }

      case "agentSetCondenseThreshold": {
        const threshold = Number(msg.threshold);
        if (!Number.isFinite(threshold)) break;
        const config = vscode.workspace.getConfiguration("agentlink");
        const currentModel =
          this.sessionManager.getForegroundSession()?.model ??
          this.sessionManager.getConfig().model;
        const thresholds = {
          ...(config.get("modelCondenseThresholds") as
            | Record<string, number>
            | undefined),
          [currentModel]: Math.min(1, Math.max(0.1, threshold)),
        };
        await config.update(
          "modelCondenseThresholds",
          thresholds,
          vscode.ConfigurationTarget.Global,
        );
        this.sessionManager.updateConfig({
          autoCondenseThreshold: thresholds[currentModel],
        });
        const fg = this.sessionManager.getForegroundSession();
        if (fg && fg.model === currentModel) {
          fg.autoCondenseThreshold = thresholds[currentModel];
          await this.sessionManager.maybeAutoCondenseForegroundSession();
        }
        this.sendInitialState();
        this.log(
          `Auto-condense threshold set to ${Math.round(thresholds[currentModel] * 100)}% for ${currentModel}`,
        );
        break;
      }

      case "agentSetWriteApproval": {
        const mode = msg.mode as string;
        if (!mode || !this.approvalManager) break;
        // Use the foreground session's actual ID so session-level approvals are
        // scoped per chat session (not shared across all foreground sessions).
        const fgSession = this.sessionManager?.getForegroundSession();
        const fgSessionId = fgSession?.id ?? "agent";
        this.approvalManager.resetAgentWriteApproval();
        if (mode !== "prompt") {
          this.approvalManager.setAgentWriteApproval(
            fgSessionId,
            mode as "session" | "project" | "global",
          );
        }
        this.sendInitialState();
        this.log(`Agent write approval changed to: ${mode}`);
        break;
      }

      case "agentPromoteMcpToolApproval": {
        const sessionId = String(msg.sessionId ?? "");
        const serverName = String(msg.serverName ?? "");
        const bareToolName = String(msg.bareToolName ?? "");
        const rawScope = String(msg.scope ?? "");
        const scope =
          rawScope === "session" ||
          rawScope === "project" ||
          rawScope === "global"
            ? rawScope
            : undefined;
        if (
          !this.approvalManager ||
          !sessionId ||
          !serverName ||
          !bareToolName ||
          !scope
        ) {
          break;
        }

        const toolName = `${serverName}__${bareToolName}`;
        this.approvalManager.approveMcpTool(sessionId, toolName);

        if (scope === "project" || scope === "global") {
          const cwd =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.cwd;
          if (!cwd) {
            vscode.window.showErrorMessage(
              "Unable to persist MCP approval: no workspace or cwd available.",
            );
            break;
          }
          const configPaths = getMcpConfigFilePaths(cwd);
          try {
            await persistMcpToolApproval(
              serverName,
              bareToolName,
              scope === "project" ? configPaths.project : configPaths.global,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `Failed to save MCP approval: ${message}`,
            );
            break;
          }
        }

        vscode.window.showInformationMessage(
          `Allowed MCP tool "${bareToolName}" from "${serverName}" for ${scope}.`,
        );
        break;
      }

      case "agentMcpAction": {
        const serverName = msg.serverName as string;
        const action = msg.action as "disable" | "reconnect" | "reauthenticate";
        if (!serverName || !action) break;
        if (action === "disable") {
          await this.mcpHub.disableServer(serverName);
        } else if (action === "reconnect") {
          await this.mcpHub.reconnectServer(serverName);
        } else if (action === "reauthenticate") {
          await this.mcpHub.reauthenticateServer(serverName);
        }
        // Push updated status to webview
        this.postMessage({
          type: "agentMcpStatus",
          infos: this.mcpHub.getServerInfos(),
        } as ExtensionToWebview);
        break;
      }

      case "agentElicitationResponse": {
        const id = msg.id as string;
        const pending = this.pendingElicitations.get(id);
        if (!pending) break;
        this.pendingElicitations.delete(id);
        for (const ids of this.elicitationSessionIndex.values()) {
          ids.delete(id);
        }
        if (msg.cancelled) {
          pending.cancel();
        } else {
          pending.resolve(msg.values as Record<string, unknown>);
        }
        break;
      }

      case "agentUrlElicitationResponse": {
        const id = msg.id as string;
        const action = msg.action as "accept" | "cancel" | "decline";
        const pending = this.pendingUrlElicitations.get(id);
        if (pending && action === "accept") {
          void vscode.env.openExternal(vscode.Uri.parse(pending.request.url));
        }
        this.resolveUrlElicitation(id, action);
        break;
      }

      case "approvalDecision": {
        const id = msg.id as string;

        this.submitBrowserApprovalDecision({
          id,
          decision: msg.decision as string | undefined,
          editedCommand: msg.editedCommand as string | undefined,
          rejectionReason: msg.rejectionReason as string | undefined,
          rulePattern: msg.rulePattern as string | undefined,
          ruleMode: msg.ruleMode as string | undefined,
          rules: msg.rules as
            | Array<{
                pattern: string;
                mode: string;
                scope: string;
              }>
            | undefined,
          trustScope: msg.trustScope as string | undefined,
          editedContent: msg.editedContent as string | undefined,
          memoryTier: msg.memoryTier as
            | import("../approvals/webview/types.js").MemoryTier
            | undefined,
          memoryScope: msg.memoryScope as
            | import("../approvals/webview/types.js").MemoryScope
            | undefined,
          memoryName: msg.memoryName as string | undefined,
          followUp: msg.followUp as string | undefined,
        });
        break;
      }

      case "agentSuggestRegex": {
        const requestId = String(msg.requestId ?? "");
        const subCommand = String(msg.subCommand ?? "");
        const fullCommand = String(msg.fullCommand ?? "");
        if (!requestId || !subCommand) break;
        void this.handleSuggestRegex({
          requestId,
          subCommand,
          fullCommand,
        });
        break;
      }

      case "agentQuestionResponse": {
        this.applyProjectedAction({ type: "CLEAR_QUESTION" });
        this.submitBrowserQuestionResponse({
          id: msg.id as string,
          answers: msg.answers as Record<
            string,
            string | string[] | number | boolean | undefined
          >,
          notes: (msg.notes as Record<string, string>) ?? {},
        });
        break;
      }

      case "agentQuestionProgress": {
        this.publishBrowserQuestionProgress({
          id: msg.id as string,
          step: Number(msg.step ?? 0),
          answers:
            (msg.answers as Record<
              string,
              string | string[] | number | boolean | undefined
            >) ?? {},
          notes: (msg.notes as Record<string, string>) ?? {},
          origin: String(msg.origin ?? "unknown"),
        });
        break;
      }

      case "agentRefreshSlashCommands": {
        this.slashRegistry?.reload().then(() => {
          this.sendSlashCommands();
          this.log(
            `[slash] refreshed: ${this.slashRegistry?.getAll().length ?? 0} commands`,
          );
        });
        break;
      }

      case "agentSlashCommand": {
        const name = msg.name as string;
        if (name === "condense") {
          const fg = this.sessionManager?.getForegroundSession();
          await this.sessionManager?.condenseCurrentSession();
          // Manual condense doesn't go through run() — emit agentDone so the
          // webview drains any messages queued during the condense operation.
          if (fg) {
            this.postMessage({
              type: "agentDone",
              sessionId: fg.id,
              totalInputTokens: fg.totalInputTokens,
              totalOutputTokens: fg.totalOutputTokens,
              totalCacheReadTokens: fg.totalCacheReadTokens,
              totalCacheCreationTokens: fg.totalCacheCreationTokens,
            });
            this.drainBrowserQueuedInterjection(fg.id);
          }
        } else if (name === "checkpoint") {
          const checkpoint =
            await this.sessionManager?.createManualCheckpoint();
          if (!checkpoint) {
            vscode.window.showInformationMessage(
              "No active session state is available to checkpoint yet.",
            );
            break;
          }
          vscode.window.showInformationMessage(
            `Checkpoint created: ${checkpoint.id.slice(0, 8)}`,
          );
        } else if (name === "revert") {
          const fg = this.sessionManager?.getForegroundSession();
          if (!fg || !this.sessionManager) break;
          const checkpoints = this.sessionManager.getCheckpoints(fg.id);
          if (checkpoints.length === 0) {
            vscode.window.showInformationMessage("No checkpoints available.");
            break;
          }

          const query = String(msg.args ?? "").trim();
          const checkpoint = query
            ? checkpoints.find(
                (candidate) =>
                  candidate.id === query || candidate.id.startsWith(query),
              )
            : checkpoints[checkpoints.length - 1];

          if (!checkpoint) {
            vscode.window.showWarningMessage(
              `No checkpoint matched "${query}".`,
            );
            break;
          }

          await this.revertCheckpointWithConfirmation(fg.id, checkpoint.id);
        } else if (name === "skills") {
          await this.slashRegistry?.reload();
          const skills = this.slashRegistry?.getSkillCommands() ?? [];
          const lines = [
            `Detected skills for mode "${this.sessionManager.getForegroundSession()?.mode ?? "code"}": ${skills.length}`,
            "",
            ...skills.map((skill) =>
              [
                `/${skill.name}`,
                `  ${skill.description}`,
                `  ${skill.skillPath ?? ""}`,
              ].join("\n"),
            ),
          ];
          this.outputChannel.appendLine(lines.join("\n"));
          this.outputChannel.show(true);
        } else if (name === "mcp") {
          const infos = this.mcpHub.getServerInfos();
          this.postMessage({
            type: "agentMcpStatus",
            infos,
            open: true,
          } as ExtensionToWebview);
        } else if (name === "mcp-config") {
          const scope =
            (msg.args as string) === "global" ? "global" : "project";
          await this.openMcpConfig(scope);
        } else if (name === "mcp-refresh") {
          await this.refreshMcpConnections();
          vscode.window.showInformationMessage("MCP servers reconnected.");
        } else if (name === "btw") {
          const question = String(msg.args ?? "").trim();
          if (question) {
            void this.handleBtwQuestion(question);
          }
        } else if (name === "pair") {
          const sub = String(msg.args ?? "")
            .trim()
            .toLowerCase();
          if (sub === "list" || sub === "devices") {
            await this.showPairedDevicesList();
          } else {
            await this.handlePairCommand();
          }
        } else {
          this.log(`[slash] /${name} not yet implemented`);
          vscode.window.showInformationMessage(
            `Unknown slash command: /${name}`,
          );
        }
        break;
      }

      case "agentOpenFile": {
        const filePath = msg.path as string;
        const line = msg.line as number | undefined;
        if (!filePath) break;
        const path = require("path");
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspaceRoot, filePath);
        const uri = vscode.Uri.file(absPath);
        const options: vscode.TextDocumentShowOptions =
          withPrimaryEditorColumn();
        if (line) {
          const pos = new vscode.Position(line - 1, 0);
          options.selection = new vscode.Range(pos, pos);
        }
        vscode.window.showTextDocument(uri, options).then(undefined, (err) => {
          this.log(`[error] Failed to open file: ${err}`);
        });
        break;
      }

      case "openBgTranscript": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          const session = this.sessionManager?.getSession(sessionId);
          if (session) {
            this.postMessage({
              type: "showBgTranscript",
              sessionId,
              task: session.title ?? "Background Agent",
              messages: stripMediaForTransport(session.getAllMessages()),
            });
          } else {
            vscode.window.showWarningMessage(
              "Background agent session not found — it may have been cleaned up.",
            );
          }
        }
        break;
      }

      case "agentOpenSpecialBlockPanel": {
        const kind = msg.kind as "mermaid" | "vega" | "vega-lite";
        const source = msg.source as string;
        if (!source?.trim()) break;
        if (!["mermaid", "vega", "vega-lite"].includes(kind)) break;
        this.openSpecialBlockPanel(kind, source);
        break;
      }

      case "agentResolveDroppedFiles": {
        const paths = msg.paths as string[];
        if (!Array.isArray(paths)) break;
        const resolved = paths.map((p: string) => getRelativePath(p));
        this.postMessage({
          type: "agentDroppedFilesResolved",
          files: resolved,
        } as ExtensionToWebview);
        break;
      }

      case "agentAttachFile": {
        const result = await this.submitBrowserAttachFile();
        if (result.files.length > 0) {
          this.postMessage({
            type: "agentDroppedFilesResolved",
            files: result.files,
          } as ExtensionToWebview);
        }
        break;
      }

      case "agentSearchFiles": {
        const query = msg.query as string;
        const requestId = msg.requestId as string;
        if (!query || !requestId) break;
        this.searchWorkspaceFiles(query, requestId);
        break;
      }

      case "agentDetectQuestion": {
        const requestId = msg.requestId as string;
        const messageId = msg.messageId as string;
        const text = msg.text as string;
        if (!requestId || !messageId || typeof text !== "string") break;

        if (this.projectedDetectRequest) {
          this.detectRequestInputs.delete(
            this.projectedDetectRequest.requestId,
          );
        }
        this.projectedDetectRequest = {
          requestId,
          messageId,
          assistantText: text,
        };
        this.detectRequestInputs.set(requestId, {
          messageId,
          assistantText: text,
          detectKey: `${messageId}:${text}`,
        });

        this.detectQuestionForWebview(requestId, messageId, text);
        break;
      }

      case "agentExportTranscript": {
        const messages = msg.messages as Array<{
          role: string;
          content: string;
          timestamp: number;
          blocks: Array<{
            type: string;
            text?: string;
            name?: string;
            inputJson?: string;
            result?: string;
            durationMs?: number;
            skillName?: string;
            path?: string;
            content?: string;
          }>;
        }>;
        this.exportTranscript(messages);
        break;
      }

      case "agentListSessions": {
        const sessions = this.sessionManager?.listPersistedSessions() ?? [];
        this.postMessage({ type: "agentSessionList", sessions });
        break;
      }

      case "agentLoadSession": {
        const sessionId = msg.sessionId as string;
        if (!sessionId || !this.sessionManager) break;
        const session =
          await this.sessionManager.loadPersistedSession(sessionId);
        if (!session) {
          this.log(`[history] session not found: ${sessionId}`);
          break;
        }
        this.postSessionLoaded(session, {
          checkpoints: this.getSessionCheckpoints(session.id),
        });
        this.sendInitialState();
        break;
      }

      case "agentDeleteSession": {
        const sessionId = msg.sessionId as string;
        if (!sessionId || !this.sessionManager) break;
        const result =
          await this.sessionManager.deletePersistedSessionWithResult(sessionId);
        if (!result.ok) {
          vscode.window.showErrorMessage(
            formatPersistedSessionMutationFailureMessage(result),
          );
          break;
        }
        this.approvalManager?.clearSession(sessionId);
        const sessions = this.sessionManager.listPersistedSessions();
        this.postMessage({ type: "agentSessionList", sessions });
        break;
      }

      case "agentRenameSession": {
        const sessionId = msg.sessionId as string;
        const title = msg.title as string;
        if (!sessionId || !title || !this.sessionManager) break;
        const result =
          await this.sessionManager.renamePersistedSessionWithResult(
            sessionId,
            title,
          );
        if (!result.ok) {
          vscode.window.showErrorMessage(
            formatPersistedSessionMutationFailureMessage(result),
          );
          break;
        }
        const sessions = this.sessionManager.listPersistedSessions();
        this.postMessage({ type: "agentSessionList", sessions });
        break;
      }

      case "agentRevertCheckpoint": {
        const sessionId = msg.sessionId as string;
        const checkpointId = msg.checkpointId as string;
        if (!sessionId || !checkpointId || !this.sessionManager) break;
        await this.revertCheckpointWithConfirmation(sessionId, checkpointId);
        break;
      }

      case "agentViewCheckpointDiff": {
        const sessionId = msg.sessionId as string;
        const checkpointId = msg.checkpointId as string;
        const scope = (msg.scope as "turn" | "all") ?? "turn";
        if (!sessionId || !checkpointId || !this.sessionManager) break;
        await this.openCheckpointDiff(sessionId, checkpointId, scope);
        break;
      }

      case "agentQueueMessage": {
        const sessionId = msg.sessionId as string;
        const text = msg.text as string;
        const queueId = msg.queueId as string;
        const displayText = msg.displayText as string | undefined;
        const isSlashCommand = msg.isSlashCommand === true;
        const slashCommandLabel = msg.slashCommandLabel as string | undefined;
        const attachments = (msg.attachments as string[] | undefined) ?? [];
        const images =
          (msg.images as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        const documents =
          (msg.documents as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        this.applyProjectedAction({
          type: "ENQUEUE_MESSAGE",
          id: queueId,
          text: displayText ?? text,
          fullText: displayText && displayText !== text ? text : undefined,
          isSlashCommand,
          slashCommandLabel,
          attachments: attachments.length > 0 ? attachments : undefined,
          images: images.length > 0 ? images : undefined,
          documents: documents.length > 0 ? documents : undefined,
        });
        if (
          sessionId &&
          queueId &&
          this.sessionManager &&
          (text ||
            attachments.length > 0 ||
            images.length > 0 ||
            documents.length > 0)
        ) {
          const session = this.sessionManager.getSession(sessionId);
          session?.setPendingInterjection(
            text,
            queueId,
            undefined,
            displayText,
            isSlashCommand,
            slashCommandLabel,
            attachments.length > 0 ? attachments : undefined,
            images.length > 0 ? images : undefined,
            documents.length > 0 ? documents : undefined,
          );
        }
        break;
      }

      case "agentUpdateQueuedMessage": {
        const sessionId = msg.sessionId as string;
        const text = msg.text as string;
        const queueId = msg.queueId as string;
        const displayText = msg.displayText as string | undefined;
        const isSlashCommand = msg.isSlashCommand === true;
        const slashCommandLabel = msg.slashCommandLabel as string | undefined;
        const attachments = (msg.attachments as string[] | undefined) ?? [];
        const images =
          (msg.images as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        const documents =
          (msg.documents as
            | Array<{ name: string; mimeType: string; base64: string }>
            | undefined) ?? [];
        this.applyProjectedAction({
          type: "EDIT_QUEUE_MESSAGE",
          id: queueId,
          text: displayText ?? text,
        });
        if (
          sessionId &&
          queueId &&
          this.sessionManager &&
          (text ||
            attachments.length > 0 ||
            images.length > 0 ||
            documents.length > 0)
        ) {
          const session = this.sessionManager.getSession(sessionId);
          session?.updatePendingInterjection(queueId, {
            text,
            displayText,
            isSlashCommand,
            slashCommandLabel,
            attachments: attachments.length > 0 ? attachments : undefined,
            images: images.length > 0 ? images : undefined,
            documents: documents.length > 0 ? documents : undefined,
          });
        }
        break;
      }

      case "agentRemoveQueuedMessage": {
        const sessionId = msg.sessionId as string;
        const queueId = msg.queueId as string;
        this.applyProjectedAction({ type: "REMOVE_FROM_QUEUE", id: queueId });
        if (sessionId && queueId && this.sessionManager) {
          const session = this.sessionManager.getSession(sessionId);
          session?.clearPendingInterjectionIf(queueId);
        }
        break;
      }

      case "agentCodexSignIn": {
        // Trigger unified OpenAI/Codex sign-in from the webview model picker.
        vscode.commands.executeCommand("agentlink.codexSignIn");
        break;
      }

      case "agentAnthropicSignIn": {
        // Trigger Anthropic API key entry from the webview model picker
        vscode.commands.executeCommand("agentlink.setAnthropicApiKey");
        break;
      }

      case "agentCodexSignOut": {
        vscode.commands.executeCommand("agentlink.codexSignOut");
        break;
      }

      case "agentCodexAddAccount": {
        vscode.commands.executeCommand("agentlink.codexAddAccount");
        break;
      }

      case "agentCopyFirstPrompt": {
        const sessionId = msg.sessionId as string;
        if (!sessionId || !this.sessionManager) break;
        const messages = this.sessionManager.loadFirstPrompt(sessionId);
        if (messages) {
          this.postMessage({
            type: "agentInjectPrompt",
            prompt: messages,
            attachments: [],
          } as ExtensionToWebview);
        }
        break;
      }
    }
  }

  private applyProjectedAction(action: Parameters<typeof reducer>[1]): void {
    this.projectedForegroundState = reducer(
      this.projectedForegroundState,
      action,
    );
    this.projectedForegroundStreaming = this.projectedForegroundState.streaming;
  }

  private maybeStartProjectedDetectedQuestionRequest(): void {
    if (this.webviewReady) return;

    const state = this.projectedForegroundState;
    if (state.streaming || state.questionRequest) {
      this.projectedDetectRequest = null;
      return;
    }

    const lastMsg = state.messages[state.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      this.projectedDetectRequest = null;
      this.projectedLastDetectKey = null;
      this.applyProjectedAction({
        type: "SET_DETECTED_QUESTION",
        detectedQuestion: null,
      });
      return;
    }

    if (state.dismissedDetectedQuestionIds.includes(lastMsg.id)) {
      this.projectedDetectRequest = null;
      this.projectedLastDetectKey = null;
      this.applyProjectedAction({
        type: "SET_DETECTED_QUESTION",
        detectedQuestion: null,
      });
      return;
    }

    if (hasFinalContinueAction(lastMsg)) {
      this.projectedDetectRequest = null;
      this.projectedLastDetectKey = null;
      this.applyProjectedAction({
        type: "SET_DETECTED_QUESTION",
        detectedQuestion: null,
      });
      return;
    }

    const assistantText = (lastMsg.blocks ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!assistantText) {
      this.projectedDetectRequest = null;
      this.projectedLastDetectKey = null;
      this.applyProjectedAction({
        type: "SET_DETECTED_QUESTION",
        detectedQuestion: null,
      });
      return;
    }

    const detectKey = `${lastMsg.id}:${assistantText}`;
    if (this.projectedLastDetectKey === detectKey) {
      return;
    }

    const active = this.projectedDetectRequest;
    if (
      active &&
      active.messageId === lastMsg.id &&
      active.assistantText === assistantText
    ) {
      return;
    }

    if (this.projectedDetectRequest) {
      this.detectRequestInputs.delete(this.projectedDetectRequest.requestId);
    }

    const requestId = `detect-question-${lastMsg.id}-${Date.now()}`;
    this.projectedDetectRequest = {
      requestId,
      messageId: lastMsg.id,
      assistantText,
    };
    this.detectRequestInputs.set(requestId, {
      messageId: lastMsg.id,
      assistantText,
      detectKey,
    });
    this.detectQuestionForWebview(requestId, lastMsg.id, assistantText);
  }

  private applyProjectedDetectedQuestionResult(
    requestId: string,
    messageId: string,
    detected: DetectedQuestion | null,
    fallback: boolean,
  ): void {
    const active = this.projectedDetectRequest;
    if (!active || active.requestId !== requestId) return;

    this.projectedDetectRequest = null;
    const input = this.detectRequestInputs.get(requestId);
    this.detectRequestInputs.delete(requestId);
    this.projectedLastDetectKey = input?.detectKey ?? null;

    const state = this.projectedForegroundState;
    const currentLast = state.messages[state.messages.length - 1];
    if (!currentLast || currentLast.id !== messageId) return;
    if (state.dismissedDetectedQuestionIds.includes(messageId)) return;
    if (hasFinalContinueAction(currentLast)) {
      this.applyProjectedAction({
        type: "SET_DETECTED_QUESTION",
        detectedQuestion: null,
      });
      return;
    }

    let nextDetected = detected;
    if (fallback) {
      nextDetected = input
        ? detectQuestionFromAssistantText(input.assistantText)
        : null;
    }

    this.applyProjectedAction({
      type: "SET_DETECTED_QUESTION",
      detectedQuestion: nextDetected
        ? { ...nextDetected, messageId: currentLast.id }
        : null,
    });
  }

  private resetProjectedForegroundState(): void {
    this.projectedForegroundState = {
      ...initialState,
    };
    this.projectedForegroundSessionId = null;
    this.projectedForegroundLoadingSessionId = null;
    this.projectedForegroundStreaming = false;
    this.projectedDetectRequest = null;
    this.projectedLastDetectKey = null;
    this.detectRequestInputs.clear();
  }

  private ensureProjectedForegroundSession(
    session: AgentSession | undefined,
  ): void {
    if (!session) {
      this.resetProjectedForegroundState();
      return;
    }

    const shouldHydrate = this.projectedForegroundSessionId !== session.id;
    if (!shouldHydrate) return;

    const allMessages =
      typeof (session as { getAllMessages?: unknown }).getAllMessages ===
      "function"
        ? session.getAllMessages()
        : [];
    this.projectedForegroundState = {
      ...initialState,
    };
    this.projectedForegroundSessionId = session.id;
    this.projectedForegroundLoadingSessionId = null;
    this.projectedForegroundStreaming = false;
    this.projectedDetectRequest = null;
    this.projectedLastDetectKey = null;
    this.detectRequestInputs.clear();
    this.projectedForegroundState = reducer(this.projectedForegroundState, {
      type: "LOAD_SESSION",
      sessionId: session.id,
      title: session.title,
      mode: session.mode,
      model: session.model,
      messages: agentMessagesToChatMessages(allMessages),
      lastInputTokens: session.lastInputTokens,
      lastOutputTokens: session.lastOutputTokens,
      checkpoints: this.getSessionCheckpoints(session.id),
      userTurnOffset: 0,
      hasMoreBefore: false,
    });
    this.projectedForegroundState = reducer(this.projectedForegroundState, {
      type: "TOKEN_ESTIMATE",
      estimatedTotalUsed: session.estimatedTotalUsed,
    });
  }

  private formatRevertRecoveryNoticeForSession(
    sessionId: string,
  ): RevertRecoveryNotice | null {
    const recovery = this.sessionManager?.getRevertRecoveryState?.(sessionId);
    return recovery ? formatRevertRecoveryNotice(recovery) : null;
  }

  private projectExtensionMessage(msg: ExtensionToWebview): void {
    const fg = this.sessionManager?.getForegroundSession();
    this.ensureProjectedForegroundSession(fg);

    const extMsg = msg as unknown as ExtensionMessage;

    if (extMsg.type === "stateUpdate") {
      this.projectedForegroundSessionId = extMsg.state.sessionId;
      if (!extMsg.state.sessionId) {
        this.resetProjectedForegroundState();
        return;
      }
      this.applyProjectedAction({ type: "SET_STATE", state: extMsg.state });
      return;
    }

    if (extMsg.type === "agentRestoreSessionStart") {
      this.applyProjectedAction({
        type: "SET_RESTORING_SESSION",
        restoring: true,
      });
      return;
    }

    if (extMsg.type === "agentRestoreSessionDone") {
      this.applyProjectedAction({
        type: "SET_RESTORING_SESSION",
        restoring: false,
      });
      return;
    }

    const eventSessionId =
      "sessionId" in extMsg
        ? (extMsg.sessionId as string | undefined)
        : undefined;
    const isBackgroundEvent =
      extMsg.type === "agentBgThinkingStart" ||
      extMsg.type === "agentBgThinkingDelta" ||
      extMsg.type === "agentBgThinkingEnd" ||
      extMsg.type === "agentBgTextDelta" ||
      extMsg.type === "agentBgToolStart" ||
      extMsg.type === "agentBgToolInputDelta" ||
      extMsg.type === "agentBgToolComplete" ||
      extMsg.type === "agentBgApiRequest" ||
      extMsg.type === "agentBgError" ||
      extMsg.type === "agentBgDone";

    if (
      shouldDropSessionScopedEvent(
        extMsg.type,
        eventSessionId,
        this.projectedForegroundSessionId,
        isBackgroundEvent,
      )
    ) {
      return;
    }

    const dropIfNotStreaming = (): boolean => {
      if (this.projectedForegroundStreaming) return false;
      const liveFg = this.sessionManager?.getForegroundSession();
      const liveStreaming = Boolean(
        liveFg &&
        (liveFg.status === "streaming" ||
          liveFg.status === "tool_executing" ||
          liveFg.status === "awaiting_approval"),
      );
      if (liveStreaming) {
        this.projectedForegroundStreaming = true;
        return false;
      }
      return true;
    };

    let shouldScheduleDetectedQuestion = true;

    switch (extMsg.type) {
      case "agentThinkingStart":
        if (dropIfNotStreaming()) break;
        this.applyProjectedAction({
          type: "THINKING_START",
          thinkingId: extMsg.thinkingId,
        });
        break;

      case "agentThinkingDelta":
        if (dropIfNotStreaming()) break;
        this.applyProjectedAction({
          type: "THINKING_DELTA",
          thinkingId: extMsg.thinkingId,
          text: extMsg.text,
        });
        break;

      case "agentThinkingEnd":
        this.applyProjectedAction({
          type: "THINKING_END",
          thinkingId: extMsg.thinkingId,
        });
        break;

      case "agentToolStart":
        if (dropIfNotStreaming()) break;
        this.applyProjectedAction({
          type: "TOOL_START",
          toolCallId: extMsg.toolCallId,
          toolName: extMsg.toolName,
        });
        break;

      case "agentToolInputDelta":
        if (dropIfNotStreaming()) break;
        this.applyProjectedAction({
          type: "TOOL_INPUT_DELTA",
          toolCallId: extMsg.toolCallId,
          partialJson: extMsg.partialJson,
        });
        break;

      case "agentToolComplete":
        this.applyProjectedAction({
          type: "TOOL_COMPLETE",
          toolCallId: extMsg.toolCallId,
          toolName: extMsg.toolName,
          result: extMsg.result,
          durationMs: extMsg.durationMs,
          input: extMsg.input,
          mcpApprovalPromotion: extMsg.mcpApprovalPromotion,
        });
        break;

      case "agentTokenEstimate":
        this.applyProjectedAction({
          type: "TOKEN_ESTIMATE",
          estimatedTotalUsed: extMsg.estimatedTotalUsed,
        });
        break;

      case "agentUserAnnotation":
        if (dropIfNotStreaming()) break;
        this.applyProjectedAction({
          type: "ADD_ANNOTATION",
          text: extMsg.text,
          badge: extMsg.badge,
        });
        break;

      case "agentTextDelta":
        if (dropIfNotStreaming()) break;
        this.applyProjectedAction({ type: "TEXT_DELTA", text: extMsg.text });
        break;

      case "agentApiRequest":
        this.applyProjectedAction({
          type: "API_REQUEST",
          requestId: extMsg.requestId,
          model: extMsg.model,
          inputTokens: extMsg.inputTokens,
          uncachedInputTokens: extMsg.uncachedInputTokens,
          outputTokens: extMsg.outputTokens,
          cacheReadTokens: extMsg.cacheReadTokens,
          cacheCreationTokens: extMsg.cacheCreationTokens,
          durationMs: extMsg.durationMs,
          timeToFirstToken: extMsg.timeToFirstToken,
          usedPreviousResponseId: extMsg.usedPreviousResponseId,
          previousResponseIdFallback: extMsg.previousResponseIdFallback,
          promptCacheKey: extMsg.promptCacheKey,
          promptCacheRetention: extMsg.promptCacheRetention,
          storeResponseState: extMsg.storeResponseState,
          providerResponseId: extMsg.providerResponseId,
          contextBreakdown: extMsg.contextBreakdown,
        });
        break;

      case "agentError":
        this.applyProjectedAction({
          type: "ERROR",
          error: extMsg.error,
          retryable: extMsg.retryable,
          code: extMsg.code,
          actions: extMsg.actions,
        });
        break;

      case "agentTodoUpdate":
        this.applyProjectedAction({ type: "TODO_UPDATE", todos: extMsg.todos });
        break;

      case "agentFinalMarker":
        this.applyProjectedAction({
          type: "SET_FINAL_MARKER",
          marker: extMsg.marker,
        });
        break;

      case "agentDone":
        this.applyProjectedAction({ type: "DONE" });
        break;

      case "agentInteractionPromptsCleared":
        this.projectedDetectRequest = null;
        this.projectedLastDetectKey = null;
        this.applyProjectedAction({ type: "CLEAR_INTERACTION_PROMPTS" });
        break;

      case "agentDebugInfo":
        this.applyProjectedAction({
          type: "SET_DEBUG_INFO",
          info: extMsg.info,
          systemPrompt: extMsg.systemPrompt,
          loadedInstructions: extMsg.loadedInstructions,
        });
        break;

      case "agentModesUpdate":
        this.applyProjectedAction({ type: "SET_MODES", modes: extMsg.modes });
        break;

      case "agentModelsUpdate":
        this.applyProjectedAction({
          type: "SET_MODELS",
          models: extMsg.models,
        });
        break;

      case "agentSlashCommandsUpdate":
        this.applyProjectedAction({
          type: "SET_SLASH_COMMANDS",
          commands: extMsg.commands,
        });
        break;

      case "agentCondense":
        this.applyProjectedAction({
          type: "ADD_CONDENSE",
          prevInputTokens: extMsg.prevInputTokens,
          newInputTokens: extMsg.newInputTokens,
          durationMs: extMsg.durationMs,
          validationWarnings: extMsg.validationWarnings,
        });
        break;

      case "agentCondenseStart":
        this.applyProjectedAction({ type: "CONDENSE_START" });
        break;

      case "agentWarning":
        this.applyProjectedAction({
          type: "ADD_WARNING",
          message: extMsg.message,
          retryDelayMs: extMsg.retryDelayMs,
          retryAt: extMsg.retryAt,
          retryAttempt: extMsg.retryAttempt,
          retryMaxAttempts: extMsg.retryMaxAttempts,
        });
        break;

      case "agentStatusUpdate":
        this.applyProjectedAction({
          type: "SET_STATUS_OVERRIDE",
          message: extMsg.message,
        });
        break;

      case "agentCondenseError":
        this.applyProjectedAction({
          type: "ADD_CONDENSE_ERROR",
          errorMessage: extMsg.error,
          retryable: extMsg.retryable,
          code: extMsg.code,
          actions: extMsg.actions,
        });
        break;

      case "agentQuestionRequest":
        this.applyProjectedAction({
          type: "SET_QUESTION",
          id: extMsg.id,
          context: extMsg.context,
          questions: extMsg.questions,
          ...(extMsg.backgroundTask
            ? { backgroundTask: extMsg.backgroundTask }
            : {}),
        });
        break;

      case "agentDetectQuestionResult": {
        shouldScheduleDetectedQuestion = false;
        const requestId = extMsg.requestId;
        const messageId = extMsg.messageId;
        const detected = extMsg.detected;
        const fallback = extMsg.fallback;
        this.applyProjectedDetectedQuestionResult(
          requestId,
          messageId,
          detected,
          fallback,
        );
        break;
      }

      case "agentSessionLoaded": {
        this.projectedForegroundLoadingSessionId = extMsg.sessionId;
        if (extMsg.hasMoreBefore !== true) {
          this.projectedForegroundLoadingSessionId = null;
        }
        this.projectedForegroundSessionId = extMsg.sessionId;
        this.applyProjectedAction({
          type: "LOAD_SESSION",
          sessionId: extMsg.sessionId,
          title: extMsg.title,
          mode: extMsg.mode,
          model: extMsg.model,
          messages: agentMessagesToChatMessages(extMsg.messages as unknown[]),
          lastInputTokens: extMsg.lastInputTokens,
          lastOutputTokens: extMsg.lastOutputTokens,
          checkpoints: extMsg.checkpoints,
          userTurnOffset: extMsg.userTurnOffset ?? 0,
          hasMoreBefore: extMsg.hasMoreBefore,
        });
        break;
      }

      case "agentSessionChunk": {
        if (
          !shouldAcceptSessionChunk(
            extMsg.sessionId,
            this.projectedForegroundSessionId,
            this.projectedForegroundLoadingSessionId,
          )
        ) {
          break;
        }
        if (extMsg.hasMoreBefore !== true) {
          this.projectedForegroundLoadingSessionId = null;
        }
        this.applyProjectedAction({
          type: "PREPEND_SESSION_CHUNK",
          messages: agentMessagesToChatMessages(extMsg.messages as unknown[]),
          userTurnOffset: extMsg.userTurnOffset,
          hasMoreBefore: extMsg.hasMoreBefore,
          checkpoints: extMsg.checkpoints,
        });
        break;
      }

      case "agentCheckpointCreated":
        this.applyProjectedAction({
          type: "SET_CHECKPOINT",
          checkpointId: extMsg.checkpointId,
          turnIndex: extMsg.turnIndex,
        });
        break;

      case "agentQueuedMessage":
        this.applyProjectedAction({
          type: "ENQUEUE_MESSAGE",
          id: extMsg.queueId,
          text: extMsg.displayText ?? extMsg.text,
          fullText:
            extMsg.displayText && extMsg.displayText !== extMsg.text
              ? extMsg.text
              : undefined,
          isSlashCommand: extMsg.isSlashCommand,
          slashCommandLabel: extMsg.slashCommandLabel,
          attachments: extMsg.attachments,
          images: extMsg.images,
          documents: extMsg.documents,
          displayMedia: extMsg.displayMedia,
          source: extMsg.source,
        });
        break;

      case "agentRemoveQueuedMessage":
        this.applyProjectedAction({
          type: "REMOVE_FROM_QUEUE",
          id: extMsg.queueId,
        });
        break;

      case "agentInterjection":
        this.applyProjectedAction({
          type: "ADD_INTERJECTION",
          text: extMsg.displayText ?? extMsg.text,
          isSlashCommand: extMsg.isSlashCommand ?? false,
          slashCommandLabel:
            extMsg.slashCommandLabel ??
            (extMsg.isSlashCommand ? extMsg.displayText : undefined),
          displayMedia: extMsg.displayMedia,
        });
        this.applyProjectedAction({
          type: "REMOVE_FROM_QUEUE",
          id: extMsg.queueId,
        });
        break;

      case "agentCommittedUserMessage":
        this.applyProjectedAction({
          type: "ADD_COMMITTED_USER_MESSAGE",
          id: extMsg.id,
          text: extMsg.displayText ?? extMsg.text,
          isSlashCommand: extMsg.isSlashCommand ?? false,
          slashCommandLabel:
            extMsg.slashCommandLabel ??
            (extMsg.isSlashCommand ? extMsg.displayText : undefined),
          origin: extMsg.origin,
          displayMedia: extMsg.displayMedia,
        });
        break;

      case "agentBgDone": {
        let bgTask = "Background Agent";
        for (const message of this.projectedForegroundState.messages) {
          for (const block of message.blocks) {
            if (
              block.type === "bg_agent" &&
              block.sessionId === extMsg.sessionId
            ) {
              bgTask = block.task;
              break;
            }
          }
        }
        const bgInfo = this.sessionManager
          ?.getBgSessionInfos()
          .find((entry) => entry.id === extMsg.sessionId);
        const bgStatus: "completed" | "error" | "cancelled" =
          bgInfo?.status === "error"
            ? "error"
            : bgInfo?.status === "cancelled"
              ? "cancelled"
              : "completed";
        this.applyProjectedAction({
          type: "BG_AGENT_DONE",
          sessionId: extMsg.sessionId,
          task: bgTask,
          status: bgStatus,
          resultText: extMsg.resultText ?? bgInfo?.resultText,
          summary: extMsg.resultSummary,
        });
        break;
      }

      default:
        break;
    }

    if (shouldScheduleDetectedQuestion) {
      this.maybeStartProjectedDetectedQuestionRequest();
    }
  }

  public getBrowserProjectedForegroundState(): {
    sessionId: string;
    mode: string;
    model: string;
    streaming: boolean;
    statusOverride: string | null;
    projectedMessages: ChatMessage[];
    lastInputTokens: number;
    lastOutputTokens: number;
    lastCacheReadTokens: number;
    estimatedTotalUsed: number;
    thinkingEnabled: boolean;
    reasoningEffort: import("./providers/types.js").ReasoningEffort;
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
    revertRecoveryNotice: AppState["revertRecoveryNotice"];
  } | null {
    const fg = this.sessionManager?.getForegroundSession();
    if (!fg) return null;

    this.ensureProjectedForegroundSession(fg);

    return {
      sessionId: fg.id,
      mode: this.projectedForegroundState.chatState.mode,
      model: this.projectedForegroundState.chatState.model,
      streaming: this.projectedForegroundState.streaming,
      statusOverride: this.projectedForegroundState.statusOverride,
      projectedMessages: [...this.projectedForegroundState.messages],
      lastInputTokens: this.projectedForegroundState.lastInputTokens,
      lastOutputTokens: this.projectedForegroundState.lastOutputTokens,
      lastCacheReadTokens: this.projectedForegroundState.lastCacheReadTokens,
      estimatedTotalUsed: this.projectedForegroundState.estimatedTotalUsed,
      thinkingEnabled: this.projectedForegroundState.thinkingEnabled,
      reasoningEffort:
        this.projectedForegroundState.chatState.reasoningEffort ??
        (this.projectedForegroundState.thinkingEnabled ? "high" : "none"),
      messageQueue: this.projectedForegroundState.messageQueue.map((entry) => ({
        ...entry,
        attachments: entry.attachments ? [...entry.attachments] : undefined,
        images: entry.images
          ? entry.images.map((image) => ({ ...image }))
          : undefined,
        documents: entry.documents
          ? entry.documents.map((document) => ({ ...document }))
          : undefined,
      })),
      questionRequest: this.projectedForegroundState.questionRequest
        ? {
            id: this.projectedForegroundState.questionRequest.id,
            context: this.projectedForegroundState.questionRequest.context,
            questions:
              this.projectedForegroundState.questionRequest.questions.map(
                (question) => ({ ...question }),
              ),
            ...(this.projectedForegroundState.questionRequest.backgroundTask
              ? {
                  backgroundTask:
                    this.projectedForegroundState.questionRequest
                      .backgroundTask,
                }
              : {}),
          }
        : null,
      detectedQuestion: this.projectedForegroundState.detectedQuestion
        ? {
            ...this.projectedForegroundState.detectedQuestion,
            options: this.projectedForegroundState.detectedQuestion.options.map(
              (option) => ({ ...option }),
            ),
          }
        : null,
      todos: this.projectedForegroundState.todos.map((todo) => ({ ...todo })),
      debugInfo: this.projectedForegroundState.debugInfo
        ? { ...this.projectedForegroundState.debugInfo }
        : null,
      systemPrompt: this.projectedForegroundState.systemPrompt,
      loadedInstructions: this.projectedForegroundState.loadedInstructions
        ? this.projectedForegroundState.loadedInstructions.map((item) => ({
            ...item,
          }))
        : null,
      restoringSession: this.projectedForegroundState.restoringSession,
      contextBudget: this.projectedForegroundState.chatState.contextBudget
        ? { ...this.projectedForegroundState.chatState.contextBudget }
        : undefined,
      condenseThreshold:
        this.projectedForegroundState.chatState.condenseThreshold,
      revertRecoveryNotice: this.projectedForegroundState.revertRecoveryNotice
        ? { ...this.projectedForegroundState.revertRecoveryNotice }
        : null,
    };
  }

  public getBrowserMcpStatusInfos(): McpServerInfo[] {
    return this.mcpHub.getServerInfos();
  }

  private handleAgentEvent(sessionId: string, event: AgentEvent): void {
    // Route foreground and background streams separately so foreground transcript
    // rendering does not depend on session-ID filtering in the webview.
    const isBackground = Boolean(
      this.sessionManager?.getSession(sessionId)?.background,
    );

    // Log all events to the output channel
    switch (event.type) {
      case "thinking_start":
        this.log(`[agent] thinking_start id=${event.thinkingId}`);
        this.postMessage({
          type: isBackground ? "agentBgThinkingStart" : "agentThinkingStart",
          sessionId,
          thinkingId: event.thinkingId,
        });
        break;

      case "thinking_delta":
        // Don't log every delta — too noisy
        if (isBackground) {
          this.postMessage({
            type: "agentBgThinkingDelta",
            sessionId,
            thinkingId: event.thinkingId,
            text: event.text,
          });
        } else {
          const tMap =
            this.thinkingDeltaBuffer.get(sessionId) ??
            new Map<string, string>();
          tMap.set(
            event.thinkingId,
            (tMap.get(event.thinkingId) ?? "") + event.text,
          );
          this.thinkingDeltaBuffer.set(sessionId, tMap);
          this.scheduleDeltaFlush();
        }
        break;

      case "thinking_end":
        this.log(`[agent] thinking_end id=${event.thinkingId}`);
        // Flush buffered thinking deltas before marking complete so content
        // arrives at the webview before the block is sealed.
        this.flushDeltaBuffersNow();
        this.postMessage({
          type: isBackground ? "agentBgThinkingEnd" : "agentThinkingEnd",
          sessionId,
          thinkingId: event.thinkingId,
        });
        break;

      case "text_delta":
        // Don't log every delta — too noisy
        if (isBackground) {
          this.postMessage({
            type: "agentBgTextDelta",
            sessionId,
            text: event.text,
          });
        } else {
          this.textDeltaBuffer.set(
            sessionId,
            (this.textDeltaBuffer.get(sessionId) ?? "") + event.text,
          );
          this.scheduleDeltaFlush();
        }
        // Keep bg strip in sync with streaming text (throttled to avoid flooding)
        if (isBackground) {
          this.sendBgSessionsUpdateThrottled();
        }
        break;

      case "tool_start":
        this.log(
          `[agent] tool_start tool=${event.toolName} id=${event.toolCallId}`,
        );
        // Flush buffered text deltas before the tool card so pre-tool text
        // arrives at the webview before agentToolStart, preserving natural order.
        this.flushDeltaBuffersNow();
        this.postMessage({
          type: isBackground ? "agentBgToolStart" : "agentToolStart",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
        // Keep bg strip in sync when a bg session starts a new tool
        if (isBackground) {
          this.sendBgSessionsUpdate();
        }
        break;

      case "tool_input_delta":
        const iMap =
          this.toolInputDeltaBuffer.get(sessionId) ?? new Map<string, string>();
        iMap.set(
          event.toolCallId,
          (iMap.get(event.toolCallId) ?? "") + event.partialJson,
        );
        this.toolInputDeltaBuffer.set(sessionId, iMap);
        this.scheduleDeltaFlush();
        break;

      case "checkpoint_created":
        this.log(
          `[agent] checkpoint_created id=${event.checkpointId} turn=${event.turnIndex}`,
        );
        this.postMessage({
          type: "agentCheckpointCreated",
          sessionId,
          checkpointId: event.checkpointId,
          // Snapshot user-turn count at this checkpoint.
          turnIndex: event.turnIndex,
        } as ExtensionToWebview);
        break;

      case "todo_update":
        this.postMessage({
          type: "agentTodoUpdate",
          sessionId,
          todos: event.todos,
        } as ExtensionToWebview);
        break;

      case "final_marker":
        this.postMessage({
          type: "agentFinalMarker",
          sessionId,
          marker: event.marker,
        } as ExtensionToWebview);
        break;

      case "tool_result": {
        // Convert tool result content to a string for the webview
        // Flush buffered tool input deltas before marking the tool complete
        // so the webview sees the full input JSON before the result arrives.
        this.flushDeltaBuffersNow();
        const resultText = event.result
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("\n");
        this.log(
          `[agent] tool_result tool=${event.toolName} id=${event.toolCallId} duration=${event.durationMs}ms`,
        );
        this.postMessage({
          type: isBackground ? "agentBgToolComplete" : "agentToolComplete",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultText,
          durationMs: event.durationMs,
          input: event.input,
          mcpApprovalPromotion: event.mcpApprovalPromotion,
        });
        // Send running token estimate so the context bar stays current
        // between API responses (tool results can add 10-100k+ tokens).
        if (!isBackground) {
          const session = this.sessionManager?.getSession(sessionId);
          if (session) {
            this.postMessage({
              type: "agentTokenEstimate",
              sessionId,
              estimatedTotalUsed: session.estimatedTotalUsed,
            } as ExtensionToWebview);
          }
        }
        // Keep bg strip in sync after tool completion. Use throttled updates to
        // avoid flooding when tools complete in quick succession.
        if (isBackground) {
          this.sendBgSessionsUpdateThrottled();
        }
        // Emit user-visible annotation for follow-ups and user rejections.
        // Tool results can be large (file reads, search output); only attempt
        // the JSON parse when a marker substring is actually present so the
        // common large-result case skips the parse entirely.
        try {
          if (
            !resultText.includes("follow_up") &&
            !resultText.includes("rejected_by_user")
          ) {
            break;
          }
          const parsed = JSON.parse(resultText);
          if (parsed.follow_up) {
            this.postMessage({
              type: "agentUserAnnotation",
              sessionId,
              text: parsed.follow_up,
              badge: "follow-up",
            });
          } else if (parsed.status === "rejected_by_user" && parsed.reason) {
            this.postMessage({
              type: "agentUserAnnotation",
              sessionId,
              text: parsed.reason,
              badge: "rejection",
            });
          }
        } catch {
          // result is not JSON — no annotation needed
        }
        break;
      }

      case "api_request":
        this.log(
          `[agent] api_request model=${event.model} in=${event.inputTokens} uncachedIn=${event.uncachedInputTokens} out=${event.outputTokens} ` +
            `cacheRead=${event.cacheReadTokens} cacheCreate=${event.cacheCreationTokens} ` +
            `duration=${event.durationMs}ms ttft=${event.timeToFirstToken}ms ` +
            `prevResp=${event.usedPreviousResponseId ? "yes" : "no"} ` +
            `fallback=${event.previousResponseIdFallback ? "yes" : "no"} ` +
            `cacheKey=${event.promptCacheKey ? "set" : "unset"}`,
        );
        this.postMessage({
          type: isBackground ? "agentBgApiRequest" : "agentApiRequest",
          sessionId,
          requestId: event.requestId,
          model: event.model,
          inputTokens: event.inputTokens,
          uncachedInputTokens: event.uncachedInputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          durationMs: event.durationMs,
          timeToFirstToken: event.timeToFirstToken,
          usedPreviousResponseId: event.usedPreviousResponseId,
          previousResponseIdFallback: event.previousResponseIdFallback,
          promptCacheKey: event.promptCacheKey,
          promptCacheRetention: event.promptCacheRetention,
          storeResponseState: event.storeResponseState,
          providerResponseId: event.providerResponseId,
          contextBreakdown: event.contextBreakdown,
        });
        break;

      case "error": {
        this.flushDeltaBuffersNow();
        this.log(
          `[agent] error: ${event.error} (retryable=${event.retryable}, code=${event.code ?? "none"})`,
        );
        const session = this.sessionManager?.getSession(sessionId);
        if (session) {
          session.appendRuntimeError({
            message: event.error,
            retryable: event.retryable,
            code: event.code,
            actions: event.actions,
          });
          this.sessionManager?.saveSession(sessionId);
        }
        this.postMessage({
          type: isBackground ? "agentBgError" : "agentError",
          sessionId,
          error: event.error,
          retryable: event.retryable,
          code: event.code,
          actions: event.actions,
        });
        // Keep bg strip in sync on error (flush any pending throttled update)
        if (isBackground) {
          if (this.bgUpdateTimer) {
            clearTimeout(this.bgUpdateTimer);
            this.bgUpdateTimer = null;
          }
          this.sendBgSessionsUpdate();
        }
        break;
      }

      case "condense_start":
        this.condenseStartTimes.set(sessionId, Date.now());
        this.postMessage({
          type: "agentCondenseStart",
          sessionId,
          isAutomatic: event.isAutomatic,
        });
        break;

      case "condense":
        this.log(
          `[agent] condensed: prev=${event.prevInputTokens} new=${event.newInputTokens}`,
        );
        const condenseDurationMs = this.condenseStartTimes.has(sessionId)
          ? Date.now() - this.condenseStartTimes.get(sessionId)!
          : 0;
        this.condenseStartTimes.delete(sessionId);
        this.postMessage({
          type: "agentCondense",
          sessionId,
          prevInputTokens: event.prevInputTokens,
          newInputTokens: event.newInputTokens,
          summary: event.summary,
          durationMs: condenseDurationMs,
          validationWarnings: event.validationWarnings,
          metadata: event.metadata,
        });
        if (__DEV_BUILD__ && this.cwd) {
          this.writeCondenseDebug(sessionId, event).catch((err) => {
            this.log(`[agent] condense debug export failed: ${err}`);
          });
        }
        break;

      case "warning":
        this.log(`[agent] warning: ${event.message}`);
        if (event.visible !== false) {
          this.postMessage({
            type: "agentWarning",
            sessionId,
            message: event.message,
            retryDelayMs: event.retryDelayMs,
            retryAt: event.retryAt,
            retryAttempt: event.retryAttempt,
            retryMaxAttempts: event.retryMaxAttempts,
          });
        }
        break;

      case "status_update":
        this.log(`[agent] status_update: ${event.message}`);
        this.postMessage({
          type: "agentStatusUpdate",
          sessionId,
          message: event.message,
        });
        break;

      case "condense_error":
        this.log(
          `[agent] condense_error: ${event.error} (retryable=${event.retryable ?? false}, code=${event.code ?? "none"})`,
        );
        this.postMessage({
          type: "agentCondenseError",
          sessionId,
          error: event.error,
          retryable: event.retryable,
          code: event.code,
          actions: event.actions,
        });
        break;

      case "user_interjection":
        this.log(`[agent] user_interjection queueId=${event.queueId}`);
        this.postMessage({
          type: "agentInterjection",
          sessionId,
          text: event.text,
          queueId: event.queueId,
          displayText: event.displayText,
          isSlashCommand: event.isSlashCommand,
          slashCommandLabel: event.slashCommandLabel,
          displayMedia: mediaToDisplayMedia({
            images: event.images,
            documents: event.documents,
          }),
        });
        break;

      case "done":
        this.flushDeltaBuffersNow();
        // Clean up any lingering agent tool calls from the sidebar tracker
        this.toolCallTracker?.clearAgentCalls(sessionId);
        this.log(
          `[agent] done totalIn=${event.totalInputTokens} totalOut=${event.totalOutputTokens} ` +
            `cacheRead=${event.totalCacheReadTokens} cacheCreate=${event.totalCacheCreationTokens}`,
        );
        const bgInfo = isBackground
          ? this.sessionManager
              ?.getBgSessionInfos()
              .find((s) => s.id === sessionId)
          : undefined;
        this.postMessage({
          type: isBackground ? "agentBgDone" : "agentDone",
          sessionId,
          totalInputTokens: event.totalInputTokens,
          totalOutputTokens: event.totalOutputTokens,
          totalCacheReadTokens: event.totalCacheReadTokens,
          totalCacheCreationTokens: event.totalCacheCreationTokens,
          ...(isBackground && {
            resultText:
              this.sessionManager
                ?.getSession(sessionId)
                ?.getLastAssistantText() ?? undefined,
            resultSummary:
              bgInfo?.resultSummary ??
              this.sessionManager?.getBackgroundResultSummary(sessionId),
          }),
        });
        if (!isBackground) {
          this.drainBrowserQueuedInterjection(sessionId);
        }
        // Refresh session list after save (SessionStore.save is called in SessionManager)
        this.sendSessionList();
        // Keep bg strip in sync on done (flush any pending throttled update)
        if (isBackground) {
          if (this.bgUpdateTimer) {
            clearTimeout(this.bgUpdateTimer);
            this.bgUpdateTimer = null;
          }
          this.sendBgSessionsUpdate();
        }
        break;
    }
  }

  private async writeCondenseDebug(
    sessionId: string,
    event: {
      prevInputTokens: number;
      newInputTokens: number;
      summary: string;
      validationWarnings?: string[];
      metadata?: {
        inputMessageCount: number;
        sourceUserMessageCount: number;
        hadPriorSummaryInInput: boolean;

        sourceHash: string;
        providerId: string;
        condenseModel: string;
        modelCandidates: string[];
        selectedModel: string;
        latestUserMessage: string;
        currentTask: string;
        pendingTasks: string[];
        canonicalUserMessages: string[];
        requestMessageCount: number;
        effectiveHistoryMessageCount: number;
        effectiveHistoryRoles: string[];
      };
    },
  ): Promise<void> {
    const { randomUUID: uuid } = require("crypto") as typeof import("crypto");
    const id = uuid().slice(0, 8);
    const dir = path.join(this.cwd, ".agentlink", "debug", "condensing", id);
    fs.mkdirSync(dir, { recursive: true });

    // Write summary result
    const summaryLines = [
      `# Condense Result`,
      ``,
      `**Session:** ${sessionId}`,
      `**Date:** ${new Date().toISOString()}`,
      `**Tokens before:** ${event.prevInputTokens.toLocaleString()}`,
      `**Tokens after:** ${event.newInputTokens.toLocaleString()}`,
      `**Reduction:** ${Math.round(((event.prevInputTokens - event.newInputTokens) / event.prevInputTokens) * 100)}%`,
      ``,
      `---`,
      ``,
      `## Summary`,
      ``,
      event.summary,
    ];
    if (event.validationWarnings && event.validationWarnings.length > 0) {
      summaryLines.push(``);
      summaryLines.push(`## Validation Warnings`);
      summaryLines.push(``);
      for (const warning of event.validationWarnings) {
        summaryLines.push(`- ${warning}`);
      }
    }
    if (event.metadata) {
      summaryLines.push(``);
      summaryLines.push(`## Metadata`);
      summaryLines.push(``);
      summaryLines.push(`- providerId: ${event.metadata.providerId}`);
      summaryLines.push(`- condenseModel: ${event.metadata.condenseModel}`);
      summaryLines.push(
        `- modelCandidates: ${event.metadata.modelCandidates.join(" | ")}`,
      );
      summaryLines.push(`- selectedModel: ${event.metadata.selectedModel}`);
      summaryLines.push(
        `- inputMessageCount: ${event.metadata.inputMessageCount}`,
      );
      summaryLines.push(
        `- sourceUserMessageCount: ${event.metadata.sourceUserMessageCount}`,
      );
      summaryLines.push(
        `- requestMessageCount: ${event.metadata.requestMessageCount}`,
      );
      summaryLines.push(
        `- effectiveHistoryMessageCount: ${event.metadata.effectiveHistoryMessageCount}`,
      );
      summaryLines.push(
        `- effectiveHistoryRoles: ${event.metadata.effectiveHistoryRoles.join(" | ")}`,
      );
      summaryLines.push(
        `- hadPriorSummaryInInput: ${event.metadata.hadPriorSummaryInInput}`,
      );
      summaryLines.push(`- sourceHash: ${event.metadata.sourceHash}`);
      summaryLines.push(``);
      summaryLines.push(`## Resume Anchor Inputs`);
      summaryLines.push(``);
      summaryLines.push(
        `- latestUserMessage: ${event.metadata.latestUserMessage}`,
      );
      summaryLines.push(`- currentTask: ${event.metadata.currentTask}`);

      summaryLines.push(``);
      summaryLines.push(`### Pending Tasks`);
      summaryLines.push(``);
      if (event.metadata.pendingTasks.length > 0) {
        for (const task of event.metadata.pendingTasks) {
          summaryLines.push(`- ${task}`);
        }
      } else {
        summaryLines.push(`- None`);
      }

      summaryLines.push(``);
      summaryLines.push(`### Canonical User Messages`);
      summaryLines.push(``);
      if (event.metadata.canonicalUserMessages.length > 0) {
        for (const message of event.metadata.canonicalUserMessages) {
          summaryLines.push(`- ${message}`);
        }
      } else {
        summaryLines.push(`- None`);
      }
    }
    fs.writeFileSync(
      path.join(dir, "condense-result.md"),
      summaryLines.join("\n"),
      "utf-8",
    );

    // Write full session transcript
    const session = this.sessionManager?.getSession(sessionId);
    if (session) {
      const transcriptLines: string[] = [
        `# Session Transcript (at time of condensing)`,
        ``,
        `**Session:** ${sessionId}`,
        `**Date:** ${new Date().toISOString()}`,
        ``,
        `---`,
        ``,
      ];
      for (const msg of session.getAllMessages()) {
        const role = msg.isSummary
          ? "Condense Summary"
          : msg.role === "user"
            ? "User"
            : "Assistant";
        transcriptLines.push(`## ${role}`);
        transcriptLines.push(``);
        if (typeof msg.content === "string") {
          transcriptLines.push(stripMemoryCandidateReminders(msg.content));
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") {
              transcriptLines.push(stripMemoryCandidateReminders(block.text));
            } else if (block.type === "tool_use") {
              transcriptLines.push(
                `**Tool call:** ${block.name}\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``,
              );
            } else if (block.type === "tool_result") {
              const resultText = Array.isArray(block.content)
                ? block.content
                    .map((c: { type: string; text?: string }) =>
                      c.type === "text" ? c.text : `[${c.type}]`,
                    )
                    .join("\n")
                : String(block.content);
              transcriptLines.push(
                `**Tool result** (id=${block.tool_use_id}):\n\`\`\`\n${resultText}\n\`\`\``,
              );
            }
          }
        }
        transcriptLines.push(``);
        transcriptLines.push(`---`);
        transcriptLines.push(``);
      }
      fs.writeFileSync(
        path.join(dir, "transcript.md"),
        transcriptLines.join("\n"),
        "utf-8",
      );
    }

    this.log(
      `[agent] condense debug exported to .agentlink/debug/condensing/${id}/`,
    );
  }

  private async exportTranscript(
    messages: Array<{
      role: string;
      content: string;
      timestamp: number;
      blocks: Array<{
        type: string;
        text?: string;
        name?: string;
        inputJson?: string;
        result?: string;
        durationMs?: number;
        skillName?: string;
        path?: string;
        content?: string;
      }>;
    }>,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const fs = require("fs");
    const path = require("path");
    const dir = path.join(workspaceRoot, ".agentlink", "transcripts");
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");
    const filePath = path.join(dir, `${timestamp}.md`);

    const lines: string[] = [
      `# Agent Transcript`,
      ``,
      `**Date:** ${now.toLocaleString()}`,
      ``,
      `---`,
      ``,
    ];

    for (const msg of messages) {
      const role = msg.role === "user" ? "User" : "Assistant";
      lines.push(`## ${role}`);
      lines.push(``);

      if (msg.role === "user") {
        lines.push(msg.content);
        lines.push(``);
        continue;
      }

      // Assistant: render blocks in order
      for (const block of msg.blocks ?? []) {
        switch (block.type) {
          case "thinking":
            lines.push(`<details><summary>Thinking</summary>`);
            lines.push(``);
            lines.push(block.text ?? "");
            lines.push(``);
            lines.push(`</details>`);
            lines.push(``);
            break;

          case "text":
            lines.push(block.text ?? "");
            lines.push(``);
            break;

          case "tool_call": {
            const duration = block.durationMs ? ` (${block.durationMs}ms)` : "";
            lines.push(`**Tool: ${block.name}**${duration}`);
            if (block.inputJson) {
              lines.push(``);
              lines.push(`\`\`\`json`);
              lines.push(block.inputJson);
              lines.push(`\`\`\``);
            }
            if (block.result) {
              lines.push(``);
              lines.push(`<details><summary>Result</summary>`);
              lines.push(``);
              lines.push(`\`\`\``);
              lines.push(block.result);
              lines.push(`\`\`\``);
              lines.push(``);
              lines.push(`</details>`);
            }
            lines.push(``);
            break;
          }

          case "skill_load": {
            const duration = block.durationMs ? ` (${block.durationMs}ms)` : "";
            lines.push(`**Skill load**${duration}`);
            if (block.skillName) lines.push(`Skill: ${block.skillName}`);
            if (block.path) lines.push(`Path: ${block.path}`);
            if (block.content) {
              lines.push(``);
              lines.push(`<details><summary>Content</summary>`);
              lines.push(``);
              lines.push(`\`\`\``);
              lines.push(block.content);
              lines.push(`\`\`\``);
              lines.push(``);
              lines.push(`</details>`);
            } else if (block.result) {
              lines.push(``);
              lines.push(`<details><summary>Result</summary>`);
              lines.push(``);
              lines.push(`\`\`\``);
              lines.push(block.result);
              lines.push(`\`\`\``);
              lines.push(``);
              lines.push(`</details>`);
            }
            lines.push(``);
            break;
          }
        }
      }

      lines.push(`---`);
      lines.push(``);
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(
      doc,
      withPrimaryEditorColumn({ preview: true }),
    );
    this.log(`Transcript exported to ${filePath}`);
  }

  /**
   * Handle /btw side question: make a one-shot completion using the current
   * session's context, without modifying conversation history.
   */
  private async handleBtwQuestion(question: string): Promise<void> {
    const requestId = randomUUID();

    this.postMessage({
      type: "agentBtwLoading",
      requestId,
      question,
    } as ExtensionToWebview);

    try {
      const result = await this.sessionManager?.runBtwQuestion(question);
      if (!result) {
        throw new Error("No active agent session manager");
      }

      this.postMessage({
        type: "agentBtwResponse",
        requestId,
        question,
        answer: result.answer,
      } as ExtensionToWebview);

      const toolSummary =
        result.toolCalls.length > 0
          ? ` tools=${result.toolCalls.map((t) => t.toolName).join(",")}`
          : "";
      this.log(
        `[btw] answered (${result.inputTokens}in/${result.outputTokens}out${toolSummary})`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`[btw] error: ${errorMsg}`);
      this.postMessage({
        type: "agentBtwResponse",
        requestId,
        question,
        answer: errorMsg,
        error: true,
      } as ExtensionToWebview);
    }
  }

  private async revertCheckpointWithConfirmation(
    sessionId: string,
    checkpointId: string,
  ): Promise<void> {
    if (!this.sessionManager) return;

    const previewResult = await this.sessionManager.previewRevert(
      sessionId,
      checkpointId,
    );
    if (!previewResult) {
      vscode.window.showErrorMessage(
        "Failed to preview checkpoint revert. Check the AgentLink Agent output channel for details.",
      );
      return;
    }
    const preview = previewResult.preview;

    const affected: string[] = [
      ...(preview?.modified.map((f) => `  ~ ${f}`) ?? []),
      ...(preview?.deleted.map((f) => `  - ${f}`) ?? []),
      ...(preview?.restored.map((f) => `  + ${f}`) ?? []),
    ];
    const detail =
      affected.length > 0
        ? `\n\nAffected files:\n${affected.slice(0, 20).join("\n")}${affected.length > 20 ? `\n  ...and ${affected.length - 20} more` : ""}`
        : "\n\nNo file changes detected.";

    const confirmed = await vscode.window.showWarningMessage(
      `Revert workspace to this checkpoint?${detail}`,
      { modal: true },
      "Revert",
    );

    if (confirmed !== "Revert") return;

    const result = await this.sessionManager.revertToCheckpoint(
      sessionId,
      checkpointId,
      previewResult.sessionRevision,
      previewResult.persistenceRevision,
    );

    if (result.ok) {
      this.log(
        `[agent] Reverted session ${sessionId} to checkpoint ${checkpointId}`,
      );
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        this.postSessionLoaded(session, {
          checkpoints: this.getSessionCheckpoints(session.id),
          // Checkpoint revert should feel immediate and deterministic.
          tailTurns: 0,
        });
      }
      if (result.restoredPrompt) {
        this.postMessage({
          type: "agentInjectPrompt",
          prompt: result.restoredPrompt,
          attachments: [],
        } as ExtensionToWebview);
      }
      this.sendInitialState();
      vscode.window.showInformationMessage("Reverted to checkpoint.");
    } else {
      const message = formatCheckpointRevertFailureMessage(result);
      this.log(
        `[agent] Checkpoint revert failed for session ${sessionId} checkpoint ${checkpointId}: ${result.reason}${result.currentRevision ? ` currentRevision=${result.currentRevision}` : ""}`,
      );
      vscode.window.showErrorMessage(message);
    }
  }

  private async openCheckpointDiff(
    sessionId: string,
    checkpointId: string,
    scope: "turn" | "all",
  ): Promise<void> {
    if (!this.sessionManager) return;

    const diff = await this.sessionManager.getCheckpointDiff(
      sessionId,
      checkpointId,
      scope,
    );

    if (!diff) {
      vscode.window.showInformationMessage("No changes in this checkpoint.");
      return;
    }

    const label =
      scope === "all" ? "Checkpoint Diff (All)" : "Checkpoint Diff (Turn)";
    const uri = vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${label}.diff`).with({
      query: Buffer.from(diff).toString("base64"),
    });

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(
      doc,
      withPrimaryEditorColumn({
        preview: true,
        preserveFocus: false,
      }),
    );
  }

  private async sendDebugInfo(): Promise<void> {
    const os = require("os");

    // VS Code environment
    const info: Record<string, string | number> = {
      // VS Code env
      "vscode.sessionId": vscode.env.sessionId,
      "vscode.machineId": vscode.env.machineId,
      "vscode.appName": vscode.env.appName,
      "vscode.appHost": vscode.env.appHost,
      "vscode.language": vscode.env.language,
      "vscode.uiKind":
        vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web",
      "vscode.remoteName": vscode.env.remoteName ?? "none",

      // Runtime
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      uptime: `${Math.round(process.uptime())}s`,

      // Workspace
      workspaceFolders:
        (vscode.workspace.workspaceFolders ?? [])
          .map((f: vscode.WorkspaceFolder) => f.uri.fsPath)
          .join(", ") || "none",
    };

    // Add all environment variables (sorted, redacting sensitive values)
    const sensitiveKeys = /key|token|secret|password|auth|credential/i;
    const envEntries = Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of envEntries) {
      const displayValue = sensitiveKeys.test(key)
        ? `${value!.slice(0, 8)}...`
        : value!;
      info[`env.${key}`] = displayValue;
    }

    // Get system prompt from foreground session. If no foreground session
    // exists yet (fresh chat), build a fallback prompt for the default mode
    // so the Environment panel can still show the System Prompt section.
    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const fg = this.sessionManager?.getForegroundSession();
    let systemPrompt = fg?.systemPrompt;
    if (!systemPrompt && this.cwd) {
      try {
        const mode = fg?.mode ?? "code";
        const model = fg?.model ?? this.sessionManager?.getConfig().model;
        const providerId = model
          ? providerRegistry.tryResolveProvider(model)?.id
          : undefined;
        systemPrompt = await buildSystemPrompt(mode, this.cwd, {
          providerId,
          activeFilePath,
          workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(
            (f) => ({ name: f.name, path: f.uri.fsPath }),
          ),
        });
      } catch (err) {
        this.log(`[warn] Failed to build debug system prompt: ${err}`);
      }
    }

    // Load instruction blocks for the preview panel
    let loadedInstructions: LoadedInstructionDebugInfo[] | undefined;
    if (this.cwd) {
      try {
        const blocks = await loadAllInstructionBlocks(this.cwd, {
          activeFilePath,
        });
        loadedInstructions = blocks.map((block) =>
          formatInstructionDebugInfo(block, this.cwd, activeFilePath),
        );
      } catch (err) {
        this.log(`[warn] Failed to load instruction blocks for debug: ${err}`);
      }
    }

    const bgRouting = this.sessionManager?.getRecentBgRoutingSummaries(5) ?? [];
    if (bgRouting.length > 0) {
      bgRouting.forEach((line, idx) => {
        info[`bg.route.${idx + 1}`] = line;
      });
    }

    this.postMessage({
      type: "agentDebugInfo",
      info,
      systemPrompt: systemPrompt ?? undefined,
      loadedInstructions,
    });
  }

  private async resolveAttachments(
    text: string,
    attachments: string[],
  ): Promise<string> {
    if (attachments.length === 0) return text;

    const fs = require("fs");
    const pathMod = require("path");
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    const blocks: string[] = [];
    for (const relPath of attachments) {
      try {
        const absPath = pathMod.isAbsolute(relPath)
          ? relPath
          : pathMod.join(workspaceRoot, relPath);
        const content = fs.readFileSync(absPath, "utf-8") as string;
        const ext = pathMod.extname(relPath).slice(1) || "";
        blocks.push(
          `<file path="${relPath}">\n\`\`\`${ext}\n${content}\n\`\`\`\n</file>`,
        );
      } catch (err) {
        this.log(`[warn] Failed to read attachment ${relPath}: ${err}`);
        blocks.push(
          `<file path="${relPath}">\n[Error: could not read file]\n</file>`,
        );
      }
    }

    // Strip the [Attached: ...] markers from the display text
    const cleanText = text.replace(/\[Attached: [^\]]+\]\n*/g, "").trim();
    return blocks.join("\n\n") + "\n\n" + cleanText;
  }

  private async searchWorkspaceFiles(
    query: string,
    requestId: string,
  ): Promise<void> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    if (!workspaceRoot) {
      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: [],
      });
      return;
    }

    try {
      // Use VS Code's findFiles API for fast glob-based search
      const pattern = query === "*" ? "**/*" : `**/*${query}*`;
      const uris = await vscode.workspace.findFiles(
        pattern,
        "**/node_modules/**",
        50,
      );

      const path = require("path");
      const files = uris.map((uri) => ({
        path: path.relative(workspaceRoot, uri.fsPath),
        kind: "file" as const,
      }));

      // Sort: prefer files whose basename starts with the query
      const lowerQuery = query.toLowerCase();
      files.sort((a, b) => {
        const aBase = path.basename(a.path).toLowerCase();
        const bBase = path.basename(b.path).toLowerCase();
        const aStarts = aBase.startsWith(lowerQuery) ? 0 : 1;
        const bStarts = bBase.startsWith(lowerQuery) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        // Then prefer shorter paths
        return a.path.length - b.path.length;
      });

      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: files.slice(0, 20),
      });
    } catch (err) {
      this.log(`[error] File search failed: ${err}`);
      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: [],
      });
    }
  }

  private async detectQuestionForWebview(
    requestId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const mode = getQuestionDetectionMode();
    let agentContext: { provider: ModelProvider; model: string } | undefined;
    if (mode === "agent") {
      const fg = this.sessionManager?.getForegroundSession();
      const provider = fg
        ? providerRegistry.tryResolveProvider(fg.model)
        : undefined;
      if (provider) {
        agentContext = { provider, model: provider.condenseModel };
      }
    }
    const outcome = await detectQuestion(text, {
      mode,
      agent: agentContext,
    });
    if (outcome.fallback && outcome.error && mode !== "heuristic") {
      this.log(
        `[question-detection] ${mode} failed: ${outcome.error} — falling back to heuristic`,
      );
    }
    this.postMessage({
      type: "agentDetectQuestionResult",
      requestId,
      messageId,
      detected: outcome.detected,
      fallback: outcome.fallback,
    });
  }

  private sendInitialState(): void {
    if (!this.sessionManager) return;

    const fg = this.sessionManager.getForegroundSession();
    const config = this.sessionManager.getConfig();
    const modelId = fg?.model ?? config.model;
    const condenseThreshold = this.getConfiguredCondenseThreshold(modelId);
    const contextBudget = this.buildContextBudget(
      fg,
      modelId,
      condenseThreshold,
    );
    const state: ChatState = {
      sessionId: fg?.id ?? null,
      mode: fg?.mode ?? "code",
      model: modelId,
      streaming:
        fg?.status === "streaming" ||
        fg?.status === "tool_executing" ||
        fg?.status === "awaiting_approval",
      condenseThreshold,
      contextBudget,
      reasoningEffort: fg?.reasoningEffort ?? "high",
      thinkingEnabled: (fg?.reasoningEffort ?? "high") !== "none",
      // Use the foreground session's ID so the write approval state reflects the
      // current session's trust level rather than a shared synthetic "agent" ID.
      agentWriteApproval: this.approvalManager?.getAgentWriteApprovalState(
        fg?.id ?? "agent",
      ),
      revertRecoveryNotice: fg
        ? this.formatRevertRecoveryNoticeForSession(fg.id)
        : null,
    };

    this.postMessage({ type: "stateUpdate", state });
    this.postMessage({
      type: "agentSessionUpdate",
      sessions: this.sessionManager.getSessionInfos(),
    });
  }

  /**
   * Re-send model list to the webview. Called externally when provider auth
   * state changes (e.g. Codex sign-in/sign-out).
   */
  public refreshModels(): void {
    // Force a dynamic refresh (bypass TTL) — e.g. provider auth state changed.
    this.maybeRefreshAnthropicModels({ force: true });
    void this.sendModelsUpdate();
  }

  /**
   * Inject a prompt into the chat input and optionally focus the panel.
   * Used by code actions (Fix/Explain with AgentLink).
   */
  public async startPromptInMode(opts: {
    prompt: string;
    mode?: string;
    autoSubmit?: boolean;
  }): Promise<void> {
    const mode = opts.mode?.trim();
    if (mode && this.sessionManager) {
      const current = this.sessionManager.getForegroundSession();
      if (current) {
        await this.sessionManager.switchForegroundMode(mode);
      } else {
        const session = await this.sessionManager.createSession(mode);
        this.postSessionLoaded(session, {
          checkpoints: this.getSessionCheckpoints(session.id),
          tailTurns: 0,
        });
      }
      this.sendInitialState();
    }
    this.injectPrompt(opts.prompt, [], opts.autoSubmit);
  }

  public injectPrompt(
    prompt: string,
    attachments?: string[],
    autoSubmit?: boolean,
  ): void {
    this.revealPanel();
    this.postMessage({
      type: "agentInjectPrompt",
      prompt,
      attachments: attachments ?? [],
      autoSubmit,
    } as ExtensionToWebview);
  }

  /**
   * Add a file attachment to the chat input.
   * Used by explorer context menu (Add File to Chat).
   */
  public injectAttachment(path: string): void {
    this.revealPanel();
    this.postMessage({
      type: "agentInjectAttachment",
      path,
    } as ExtensionToWebview);
  }

  /**
   * Inject context text into the chat input.
   * Used by editor context menu (Add Selection to Chat).
   */
  public injectContext(context: string): void {
    this.revealPanel();
    this.postMessage({
      type: "agentInjectContext",
      context,
    } as ExtensionToWebview);
  }

  private revealPanel(): void {
    if (this.view) {
      this.view.show(true);
    } else {
      // Panel hasn't been opened yet — force VS Code to create it
      vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  }

  /**
   * Build checkpoint mapping for a session.
   * `turnIndex` is the count of visible user turns already committed at the
   * checkpoint snapshot; the webview renders the badge on the preceding user row.
   */
  private getSessionCheckpoints(
    sessionId: string,
  ): Array<{ turnIndex: number; checkpointId: string }> | undefined {
    const getCheckpoints = this.sessionManager?.getCheckpoints;
    if (typeof getCheckpoints !== "function") return undefined;
    const checkpoints = getCheckpoints.call(this.sessionManager, sessionId);
    if (!checkpoints || checkpoints.length === 0) return undefined;
    return checkpoints.map((c) => ({
      turnIndex: c.turnIndex,
      checkpointId: c.id,
    }));
  }

  private drainBrowserQueuedInterjection(sessionId: string): void {
    const session = this.sessionManager?.getSession(sessionId);
    if (!session) return;
    const queued = this.projectedForegroundState.messageQueue.find(
      (entry) =>
        entry.source === "browser" && session.hasPendingInterjection(entry.id),
    );
    if (!queued) return;

    const pending = session.clearPendingInterjectionIf(queued.id);
    if (!pending) return;

    this.applyProjectedAction({ type: "REMOVE_FROM_QUEUE", id: queued.id });
    this.sendOrQueueWebviewMessage({
      type: "agentRemoveQueuedMessage",
      sessionId,
      queueId: queued.id,
    });

    const mode = session.mode;
    const reasoningEffort = session.reasoningEffort;
    const thinkingEnabled = reasoningEffort !== "none";
    const displayText = pending.displayText ?? pending.text;
    const displayMedia = mediaToDisplayMedia({
      images: pending.images,
      documents: pending.documents,
    });

    this.postMessage({
      type: "agentCommittedUserMessage",
      sessionId,
      id: pending.messageId,
      text: pending.text,
      displayText,
      isSlashCommand: pending.isSlashCommand,
      slashCommandLabel: pending.slashCommandLabel,
      origin: "browser",
      displayMedia,
    });

    this.sessionManager
      ?.sendMessage(sessionId, pending.text, mode, {
        thinkingEnabled,
        reasoningEffort,
        activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
        displayText,
        isSlashCommand: pending.isSlashCommand,
        slashCommandLabel: pending.slashCommandLabel,
        origin: "browser",
        images: pending.images,
        documents: pending.documents,
      })
      .catch((err) => {
        this.log(`[error] browser queued send failed: ${err}`);
      });
  }

  private postMessage(msg: ExtensionToWebview): void {
    this.projectExtensionMessage(msg);
    this.sendOrQueueWebviewMessage(msg);
  }

  private sendOrQueueWebviewMessage(msg: ExtensionToWebview): void {
    if (!this.webviewReady || !this.view) {
      this.pendingMessages.push(msg);
      return;
    }

    Promise.resolve(this.view.webview.postMessage(msg)).then(
      (delivered) => {
        if (delivered !== false) return;
        this.handleWebviewPostMessageFailure(msg, "postMessage returned false");
      },
      (err: unknown) => {
        this.handleWebviewPostMessageFailure(msg, String(err));
      },
    );
  }

  private flushPendingWebviewMessages(): void {
    if (this.pendingMessages.length === 0) return;

    const pending = this.pendingMessages;
    this.pendingMessages = [];
    for (let i = 0; i < pending.length; i += 1) {
      const msg = pending[i];
      if (!msg) continue;
      this.sendOrQueueWebviewMessage(msg);
      if (!this.webviewReady) {
        this.pendingMessages.push(...pending.slice(i + 1));
        break;
      }
    }
  }

  private handleWebviewPostMessageFailure(
    msg: ExtensionToWebview,
    reason: string,
  ): void {
    if (!this.webviewReady && this.pendingMessages.includes(msg)) return;

    this.log(`[webview] postMessage failed; queueing until ready: ${reason}`);
    this.webviewReady = false;
    this.pendingMessages.push(msg);
  }

  private postSessionLoaded(
    session: AgentSession,
    opts?: {
      restored?: boolean;
      tailTurns?: number;
      backfillBatchTurns?: number;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
    },
  ): void {
    const all = session.getAllMessages();
    const tail = getTailChunkByUserTurns(
      all,
      opts?.tailTurns ?? RESTORE_TAIL_TURNS,
    );
    this.postMessage({
      type: "agentSessionLoaded",
      sessionId: session.id,
      title: session.title,
      mode: session.mode,
      model: session.model,
      messages: tail.chunk,
      lastInputTokens: session.lastInputTokens,
      // lastOutputTokens is the per-last-request output count used for
      // context bar display. We don't persist this value, so send 0 for
      // loaded sessions to avoid displaying stale cumulative totals.
      lastOutputTokens: 0,
      restored: opts?.restored,
      checkpoints: opts?.checkpoints,
      userTurnOffset: tail.userTurnOffset,
      hasMoreBefore: tail.hasMoreBefore,
    });

    if (!tail.hasMoreBefore) return;

    const prefix = all.slice(0, all.length - tail.chunk.length);
    const chunks = getBackfillChunksByUserTurns(
      prefix,
      opts?.backfillBatchTurns ?? RESTORE_BACKFILL_BATCH_TURNS,
    );
    const checkpoints = opts?.checkpoints;
    for (const chunk of chunks) {
      this.postMessage({
        type: "agentSessionChunk",
        sessionId: session.id,
        messages: chunk.messages,
        userTurnOffset: chunk.userTurnOffset,
        hasMoreBefore: chunk.hasMoreBefore,
        checkpoints,
      });
    }
  }

  private getBrowserGatewayTerminalSettingsCssVariables(): Record<
    string,
    string
  > {
    const config = vscode.workspace.getConfiguration("terminal.integrated");
    const cssVariables: Record<string, string> = {};

    const fontFamily = config.get<string>("fontFamily")?.trim();
    if (fontFamily) {
      cssVariables["--vscode-terminal-fontFamily"] = fontFamily;
    }

    const fontSize = config.get<number>("fontSize");
    if (typeof fontSize === "number" && Number.isFinite(fontSize)) {
      cssVariables["--vscode-terminal-fontSize"] = `${fontSize}px`;
    }

    const lineHeight = config.get<number>("lineHeight");
    if (typeof lineHeight === "number" && Number.isFinite(lineHeight)) {
      cssVariables["--vscode-terminal-lineHeight"] = String(lineHeight);
    }

    const letterSpacing = config.get<number>("letterSpacing");
    if (typeof letterSpacing === "number" && Number.isFinite(letterSpacing)) {
      cssVariables["--vscode-terminal-letterSpacing"] = `${letterSpacing}px`;
    }

    const fontWeight = config.get<string | number>("fontWeight");
    if (typeof fontWeight === "string" && fontWeight.trim()) {
      cssVariables["--vscode-terminal-fontWeight"] = fontWeight.trim();
    } else if (typeof fontWeight === "number" && Number.isFinite(fontWeight)) {
      cssVariables["--vscode-terminal-fontWeight"] = String(fontWeight);
    }

    return cssVariables;
  }

  private parseThemeSnapshot(
    msg: Record<string, unknown>,
  ): BrowserGatewayThemeSnapshot | null {
    const raw = msg.cssVariables;
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const cssVariables: Record<string, string> = {
      ...this.getBrowserGatewayTerminalSettingsCssVariables(),
    };
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!key.startsWith("--vscode-")) continue;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      // Disallow URL-like constructs in forwarded CSS values.
      if (/url\s*\(/i.test(trimmed)) continue;
      cssVariables[key] = trimmed;
    }

    const colorSchemeRaw =
      typeof msg.colorScheme === "string" ? msg.colorScheme : undefined;
    const colorScheme =
      colorSchemeRaw === "light" ||
      colorSchemeRaw === "dark" ||
      colorSchemeRaw === "hc" ||
      colorSchemeRaw === "hc-light"
        ? colorSchemeRaw
        : undefined;

    const themeLabel =
      typeof msg.themeLabel === "string" ? msg.themeLabel : undefined;

    return {
      cssVariables,
      colorScheme,
      themeLabel,
      source: "webview-dom",
    };
  }

  private getFallbackThemeSnapshot(): BrowserGatewayThemeSnapshot {
    const kind = vscode.window.activeColorTheme.kind;
    const colorScheme: BrowserGatewayThemeSnapshot["colorScheme"] =
      kind === vscode.ColorThemeKind.Light
        ? "light"
        : kind === vscode.ColorThemeKind.HighContrast
          ? "hc"
          : kind === vscode.ColorThemeKind.HighContrastLight
            ? "hc-light"
            : "dark";
    const themeLabel =
      kind === vscode.ColorThemeKind.Light
        ? "Light"
        : kind === vscode.ColorThemeKind.HighContrast
          ? "High Contrast"
          : kind === vscode.ColorThemeKind.HighContrastLight
            ? "High Contrast Light"
            : "Dark";

    return {
      cssVariables: this.getBrowserGatewayTerminalSettingsCssVariables(),
      colorScheme,
      themeLabel,
      source: "vscode-theme-api",
    };
  }

  private getHtml(): string {
    const webview = this.view!.webview;
    const nonce = randomUUID().replace(/-/g, "");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "chat.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "chat.css"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicon.css"),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>AgentLink Chat</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private openSpecialBlockPanel(
    kind: "mermaid" | "vega" | "vega-lite",
    source: string,
  ): void {
    const existing = this.specialBlockPanel;
    if (existing) {
      existing.title = this.getSpecialBlockPanelTitle(kind);
      existing.webview.html = this.getSpecialBlockPanelHtml(
        existing.webview,
        kind,
        source,
      );
      existing.reveal(vscode.ViewColumn.Beside, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "agentlinkSpecialBlockPreview",
      this.getSpecialBlockPanelTitle(kind),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "mermaid"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "vega"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "vega-lite"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "vega-embed"),
        ],
      },
    );

    this.specialBlockPanel = panel;
    panel.onDidDispose(() => {
      if (this.specialBlockPanel === panel) {
        this.specialBlockPanel = undefined;
      }
    });
    panel.webview.html = this.getSpecialBlockPanelHtml(
      panel.webview,
      kind,
      source,
    );
  }

  private getSpecialBlockPanelTitle(
    kind: "mermaid" | "vega" | "vega-lite",
  ): string {
    if (kind === "mermaid") return "Mermaid Diagram";
    if (kind === "vega-lite") return "Vega-Lite Chart";
    return "Vega Chart";
  }

  private getSpecialBlockPanelHtml(
    webview: vscode.Webview,
    kind: "mermaid" | "vega" | "vega-lite",
    source: string,
  ): string {
    const nonce = randomUUID().replace(/-/g, "");
    const escapedSource = JSON.stringify(source);
    const escapedKind = JSON.stringify(kind);
    const mermaidModuleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "mermaid",
        "dist",
        "mermaid.esm.min.mjs",
      ),
    );
    const vegaEmbedModuleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "vega-embed",
        "build",
        "embed.js",
      ),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval' blob:; worker-src blob:; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:;">
  <title>${this.getSpecialBlockPanelTitle(kind)}</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      padding: 16px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    #diagram {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      overflow: auto;
      min-height: 120px;
      background: var(--vscode-editor-background);
    }
    #diagram svg,
    #diagram canvas {
      display: block;
      margin: 0 auto;
      max-width: 100%;
      height: auto;
    }
    .error {
      color: var(--vscode-errorForeground);
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div id="diagram">Rendering preview...</div>
  <script nonce="${nonce}" type="module">
    import mermaid from "${mermaidModuleUri}";
    import embed from "${vegaEmbedModuleUri}";
    const source = ${escapedSource};
    const kind = ${escapedKind};
    const target = document.getElementById("diagram");

    const escapeHtml = (value) => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    try {
      if (kind === "mermaid") {
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "loose",
          fontFamily: "var(--vscode-font-family)",
          themeVariables: {
            primaryColor: "#2a5e58",
            primaryTextColor: "#e0e0e0",
            primaryBorderColor: "#4EC9B0",
            secondaryColor: "#1e3a36",
            secondaryTextColor: "#e0e0e0",
            secondaryBorderColor: "#3ba89f",
            tertiaryColor: "#163330",
            tertiaryTextColor: "#e0e0e0",
            tertiaryBorderColor: "#2d7a72",
            lineColor: "#4EC9B0",
            textColor: "#e0e0e0"
          }
        });
        const id = "special-block-panel-" + Date.now();
        const { svg } = await mermaid.render(id, source);
        target.innerHTML = svg;
      } else {
        const spec = JSON.parse(source);
        target.innerHTML = "";
        await embed(target, spec, {
          actions: false,
          renderer: "svg",
          mode: kind,
          theme: "dark"
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      target.innerHTML = '<div class="error">Failed to render preview: ' + escapeHtml(message) + "</div>";
    }
  </script>
</body>
</html>`;
  }
}

/**
 * Extract a regex pattern from a model response. Strips surrounding code
 * fences/backticks and `/.../` delimiters if the model included them.
 */
function extractRegexPattern(raw: string): string | undefined {
  let text = raw.trim();
  if (!text) return undefined;

  const fenceMatch = text.match(/^```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  text = text.replace(/^[`'"]+|[`'"]+$/g, "").trim();

  const slashMatch = text.match(/^\/(.+)\/[a-z]*$/);
  if (slashMatch) {
    text = slashMatch[1];
  }

  const firstLine = text.split(/\r?\n/)[0]?.trim();
  return firstLine || undefined;
}

function validateSuggestedCommandRegex(
  pattern: string,
  subCommand: string,
): void {
  if (pattern.length > 300) {
    throw new Error("Model returned an overly long regex");
  }
  if (hasHighRiskRegexBacktrackingShape(pattern)) {
    throw new Error("Model returned a regex with unsafe backtracking risk");
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `Model returned an invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new Error("Model returned an unanchored regex");
  }
  if (!regex.test(subCommand.trim())) {
    throw new Error(
      "Model returned a regex that does not match the current command",
    );
  }
}

function hasHighRiskRegexBacktrackingShape(pattern: string): boolean {
  const groups =
    pattern.match(/\((?:\?:)?(?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/g) ??
    [];
  return groups.some((group) => /\.\*|\.\+/.test(group));
}
