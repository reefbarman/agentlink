import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { isCoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import {
  normalizeCoreWebAccessSettings,
  type CoreWebAccessSettings,
} from "../core/webAccess.js";
import { providerRegistry, queryProviderUsage } from "./providers/index.js";
import {
  getProviderAuxiliaryModel,
  type ModelProvider,
} from "./providers/types.js";
import type {
  BtwBudget,
  ExtensionMessage,
  ProviderUsageCardData,
  WorktreeSetupConfig,
} from "./webview/types.js";
import type { ChatSessionHistorySummary as WebviewSessionSummary } from "@agentlink/protocol/chat-session-history";
import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import type {
  ChatModelInfo as WebviewModelInfo,
  ChatProjectInfo as ProjectInfo,
  ChatSlashCommandInfo as SlashCommandInfo,
} from "@agentlink/protocol/chat-catalog";
import { getConfiguredBaseThresholdForModel } from "./modelCondenseThresholds.js";
import { getModeModelPreferences } from "./modeModelPreferences.js";
import { getModeReasoningEffortPreferences } from "./modeReasoningEffortPreferences.js";
import type {
  AgentSessionManager,
  CheckpointRevertResult,
  PersistedSessionMutationResult,
  SessionApprovalMode,
} from "./AgentSessionManager.js";
import type { AgentSession } from "./AgentSession.js";
import type { ChatTabController } from "./ChatTabController.js";
import { ChatTabHostCoordinator } from "./ChatTabHostCoordinator.js";
import type { ChatPaneConnection } from "./ChatPaneConnection.js";
import type { ChatPaneLease } from "./ChatPaneAuthorityController.js";
import type { ChatTabPanelHost } from "./ChatTabPanelHost.js";
import {
  createChatWorkspaceViewSnapshot,
  parseChatTabActionAddress,
  selectedWorkspaceSessionId,
  type ChatTab,
  type ChatTabActionAddress,
  type ChatTabActionConfirmationRequest,
  type ChatTabActionFailure,
  type ChatTabActionRejection,
  type ChatWorkspaceViewSnapshot,
} from "@agentlink/protocol/chat-workspace";
import {
  SessionApprovalPolicyCoordinator,
  type AgentWriteApprovalSelection,
  type SessionApprovalPolicyTransitionResult,
} from "./sessionApprovalPolicy.js";
import type { SessionSummary } from "./SessionStore.js";
import type { WorkspaceHistoryLocationDiagnostic } from "./workspaceSessionIdentity.js";
import type {
  PendingQuestionRecoveryState,
  RevertRecoveryState,
} from "./persistenceContracts.js";
import type { AgentErrorActions } from "@agentlink/protocol/agent-error-presentation";
import type { AgentEvent } from "./types.js";
import type { ComposeTrace } from "@agentlink/protocol/compose";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import type {
  BackgroundCompletionResult,
  InFlightAssistantBlock,
  RevertRecoveryNotice,
} from "@agentlink/protocol/session-hydration";
import type {
  CondenseMetadata,
  RequestContextBreakdown,
} from "@agentlink/protocol/context-diagnostics";
import type {
  McpApprovalPromotionMeta,
  ToolResult,
} from "@agentlink/protocol/tool-result";
import type {
  McpConfigBatchMutation,
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerProfile,
  McpManagerScope,
  McpManagerServerDraft,
  McpManagerView,
  McpServerConnectionOutcome,
} from "@agentlink/protocol/mcp-manager";
import type { McpUrlElicitationRequest } from "@agentlink/protocol/mcp-url-elicitation";
import type {
  McpFormElicitationRequest,
  McpFormElicitationResponse,
} from "@agentlink/protocol/mcp-elicitation";
import { withPrimaryEditorColumn } from "../util/editorPlacement.js";
import type { InstructionBlock } from "./configLoader.js";
import {
  getFinalMessageContinueAction,
  type FinalMessageMarker,
} from "@agentlink/protocol/final-status";
import { buildFileSearchPattern } from "./fileMentionSearch.js";
import { getLatestTodoState, type TodoItem } from "./todoTool.js";
import {
  resolveProjectAttachments,
  resolveProjectImagePreviews,
  type ResolvedAttachmentImagePreview,
  type ResolvedAttachments,
} from "./attachmentResolver.js";
import { ProjectCustomizationRegistry } from "./ProjectCustomizationRegistry.js";
import type {
  AgentPluginInstallTarget,
  AgentPluginManagerHost,
} from "./AgentPluginManagerHost.js";
import type { AgentPluginManagerAction } from "@agentlink/protocol/agent-plugin-manager";
import type { AgentPluginInstallCandidate } from "./AgentPluginInstaller.js";
import { parsePluginCommandArgs } from "./agentPluginSources.js";
import { getSkillDiscoveryRoots } from "./skillLoader.js";
import { ProjectMcpHubRegistry } from "./ProjectMcpHubRegistry.js";
import type { AgentPluginCatalogProvider } from "./AgentPluginCatalog.js";
import {
  agentPluginMcpRuntimeServerName,
  authorizeAgentPluginMcpTool,
  isAgentPluginMcpConfigCurrent,
  loadWorkspaceMcpRuntimeConfigs,
} from "./agentPluginMcpRuntime.js";
import {
  DefaultMcpPolicyMutationProvider,
  type McpPolicyMutationProvider,
} from "./McpPolicyMutationProvider.js";
import {
  McpClientHub,
  type McpConnectOptions,
  type McpServerInfo,
} from "./McpClientHub.js";
import { McpAuthCoordinator } from "./mcpAuthCoordinator.js";
import {
  McpFormElicitationCoordinator,
  type McpFormElicitationSubmitResult,
} from "./McpFormElicitationCoordinator.js";
import { cleanupOrphanedMcpOAuthState } from "./McpOAuthProvider.js";
import {
  dispatchToolCall,
  getAgentTools,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import { MCP_TOOL_BRIDGE_TOOL_NAMES } from "../shared/mcpToolDefinitions.js";
import {
  type AgentUiPublisher,
  FanoutAgentUiPublisher,
  InMemoryAgentUiEventHub,
  type ReadableAgentUiEventHub,
  WebviewAgentUiPublisher,
} from "./AgentUiPublisher.js";
import {
  buildMcpConfigEntries,
  buildMcpConfigRevision,
  getAskAgentMcpConfigPaths,
  getAskAgentMcpConfigFilePaths,
  getGlobalMcpConfigPaths,
  getMcpConfigFilePaths,
  getMcpConfigSources,
  loadAskAgentMcpConfigs,
  loadWorkspaceMcpConfigs,
  mutateMcpConfigBatch,
  persistMcpToolApproval,
} from "./mcpConfig.js";
import { BUILT_IN_MODES } from "./modes.js";
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
import { classifyGuardianPathRisk } from "../approvals/actionApprovalReview.js";
import { isMemoryProtectedPath } from "../approvals/protectedPaths.js";
import type { AgentToolCallTracker } from "./AgentToolCallTracker.js";
import { ContextJumpTracker } from "../telemetry/ContextJumpTracker.js";
import {
  createBrowserForegroundSnapshot,
  type BrowserForegroundSnapshot,
} from "./browserForegroundSnapshot.js";
import { DeltaBufferFlusher } from "./DeltaBufferFlusher.js";
import { ProjectedForegroundStore } from "./ProjectedForegroundStore.js";
import { DIFF_VIEW_URI_SCHEME } from "../integrations/diffViewContentProvider.js";
import {
  canonicalizePath,
  getRelativePath,
  isPathWithinRoot,
  resolveAndValidatePath,
} from "../util/paths.js";
import {
  detectQuestion,
  getQuestionDetectionMode,
} from "./questionDetectionLlm.js";
import { buildCommandRegexSuggestionPrompt } from "./commandRegexSuggestion.js";
import {
  buildPromptPolishPrompt,
  extractPolishedPrompt,
} from "./promptPolish.js";
import { getApprovalResultAnnotation } from "./approvalResultAnnotation.js";
import { detectQuestionFromAssistantText } from "./webview/questionDetection.js";
import type { DetectedQuestion } from "@agentlink/protocol/question-detection";
import {
  agentMessagesToChatMessages,
  reducer,
  shouldDropSessionScopedEvent,
  shouldProjectBackgroundCompletion,
  type AppState,
  type LoadedInstructionDebugInfo,
} from "../shared/chatProjection.js";
import { stripMemoryCandidateReminders } from "../shared/memoryCandidates.js";
import {
  commandApprovalPolicyFromLegacyTier,
  isCommandApprovalPolicy,
  type CommandApprovalPolicy,
} from "@agentlink/protocol/command-approval-policy";
import {
  createSessionProjectScope,
  isProjectlessSessionScope,
  type SessionProjectScope,
} from "@agentlink/protocol/workspace-project";
import { createWorkspaceProjectId } from "../core/workspaceProjects.js";
import { normalizeUserQuestionAttachments } from "@agentlink/protocol/structured-question";
import type { MemoryInspectionProvider } from "../core/capabilities/memory.js";
import type {
  ManageMemoryToolInput,
  MemoryArchiveV1,
  MemoryInspectionQueryRequest,
  MemoryPanelSnapshot,
  MemoryRecordDetail,
  MemoryToolScope,
} from "@agentlink/protocol/autonomous-memory";
import { buildContextDoctorReport } from "./contextDoctor.js";
import {
  INITIAL_CONTEXT_HEALTH,
  projectIndexHealth,
  projectMemoryHealth,
  projectRetrievalHealth,
  type ContextHealthSnapshot,
  type ContextIndexHealthInput,
} from "@agentlink/protocol/context-health";
import type { MemoryHealthSnapshot } from "@agentlink/protocol/autonomous-memory";
import type { RetrievalHealthSnapshot } from "../core/retrieval/contracts.js";
import {
  createGitHubReviewWorktreeDraft,
  extractWorktreeSetupConfig,
  parseWorktreeSlashCommand,
  type WorktreeSlashDraft,
} from "../worktree/worktreeSlashCommand.js";

type DisplayMedia = NonNullable<ChatMessage["displayMedia"]>;
type RawDisplayImage = { name: string; mimeType: string; base64: string };
type RawDisplayDocument = { name: string; mimeType: string; base64?: string };

export function resolveReasoningEffortMessage(
  value: unknown,
  thinkingEnabled: unknown,
): import("./providers/types.js").ReasoningEffort | undefined {
  if (isCoreReasoningEffort(value)) return value;
  return thinkingEnabled === false ? "none" : undefined;
}

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
  recovery: RevertRecoveryState & { projectId: string },
): RevertRecoveryNotice {
  const workspaceSuffix = recovery.workspaceRevision
    ? ` Workspace revision: ${recovery.workspaceRevision.slice(0, 12)}.`
    : "";
  return {
    projectId: recovery.projectId,
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
    case "workspace_mutation_conflict":
      return "Checkpoint revert was cancelled because the workspace changed in another session or after the preview. Refresh the checkpoint preview and try again.";
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
 * Cadence of the host→webview liveness beat. The webview flags the host as
 * unresponsive after `HOST_HEARTBEAT_STALE_MS` (webview-side constant) without
 * a beat, so this must stay comfortably below that threshold.
 */
export const HOST_HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Webview protocol types — messages between extension and chat webview.
 * Mirrored in src/agent/webview/types.ts for the browser side.
 */
export type ExtensionToWebview =
  | { type: "stateUpdate"; state: ChatState }
  | { type: "hostHeartbeat"; at: number }
  | { type: "chatWorkspaceUpdate"; snapshot: ChatWorkspaceViewSnapshot }
  | {
      type: "chatTabActionConfirmationRequested";
      request: ChatTabActionConfirmationRequest;
    }
  | { type: "chatTabActionRejected"; rejection: ChatTabActionRejection }
  | { type: "chatTabActionFailed"; failure: ChatTabActionFailure }
  | { type: "agentFleetEvent"; sessionId: string; event: unknown }
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
      parentCallId?: string;
      input?: unknown;
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
      resultImages?: Array<{ mimeType: string; data: string }>;
      resultDocuments?: Array<{
        name: string;
        mimeType: string;
        data: string;
      }>;
      durationMs: number;
      input?: unknown;
      parentCallId?: string;
      mcpApprovalPromotion?: McpApprovalPromotionMeta;
      composeTrace?: ComposeTrace;
    }
  | {
      type: "agentUserAnnotation";
      sessionId: string;
      text: string;
      badge: "follow-up" | "rejection";
    }
  | {
      type: "agentSurfaceChange";
      sessionId: string;
      change: NonNullable<ChatMessage["surfaceChange"]>;
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
      reasoningEffort: import("./providers/types.js").ReasoningEffort;
      mode?: string;
      commandApprovalPolicy?: CommandApprovalPolicy;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      usageEstimated?: boolean;
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
      /** Transcript revision after the completed turn's final deltas were committed. */
      transcriptRevision?: number;
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
      type: "agentQueueInterjectionReady";
      sessionId: string;
      queueId: string;
      ready: boolean;
    }
  | {
      type: "agentQueueInterjectionReady";
      sessionId: string;
      queueId: string;
      ready: boolean;
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
      type: "agentOpenFileResult";
      requestId: string;
      ok: boolean;
      error?: "not_found" | "open_failed";
    }
  | {
      type: "agentDetectQuestionResult";
      requestId: string;
      messageId: string;
      detected:
        | import("@agentlink/protocol/question-detection").DetectedQuestion
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
      type: "agentAttachmentPreviewsResolved";
      images: ResolvedAttachmentImagePreview[];
    }
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
      type: "agentHandoffDraft";
      draft: import("./sessionHandoff.js").SessionHandoffDraft;
    }
  | {
      type: "agentHandoffResult";
      ok: boolean;
      successorSessionId?: string;
      error?: string;
    }
  | { type: "agentModelsUpdate"; models: WebviewModelInfo[] }
  | { type: "agentModeSwitchRequest"; mode: string; reason?: string }
  | { type: "agentFormElicitationRequest"; request: McpFormElicitationRequest }
  | { type: "agentFormElicitationCleared"; id: string }
  | { type: "agentUrlElicitationRequest"; request: McpUrlElicitationRequest }
  | { type: "agentUrlElicitationCleared"; id: string }
  | {
      type: "agentMcpStatus";
      open?: boolean;
      view?: McpManagerView;
      infos: Array<{
        name: string;
        status: string;
        error?: string;
        toolCount: number;
        resourceCount: number;
        promptCount: number;
      }>;
      configSnapshot?: McpConfigSnapshot;
    }
  | { type: "agentMcpConfigMutationResult"; result: McpConfigMutationResult }
  | {
      type: "agentPluginManagerSnapshot";
      open?: boolean;
      snapshot: import("@agentlink/protocol/agent-plugin-manager").AgentPluginManagerSnapshot;
    }
  | {
      type: "agentMemoryPanelUpdate";
      requestId?: string;
      open?: boolean;
      scope: MemoryToolScope;
      availableScopes: MemoryToolScope[];
      snapshot?: MemoryPanelSnapshot;
      selected?: MemoryRecordDetail | null;
      error?: string;
    }
  | { type: "showApproval"; sessionId?: string; request: ApprovalRequest }
  | { type: "idle"; sessionId?: string; id: string }
  | {
      type: "regexSuggestion";
      requestId: string;
      pattern?: string;
      error?: string;
    }
  | {
      type: "promptPolishResult";
      requestId: string;
      polished?: string;
      error?: string;
    }
  | {
      type: "agentQuestionRequest";
      sessionId?: string;
      id: string;
      toolCallId?: string;
      context: string;
      questions: import("@agentlink/protocol/structured-question").UserQuestion[];
      backgroundTask?: string;
    }
  | { type: "agentQuestionCleared"; sessionId?: string; id: string }
  | {
      type: "agentQuestionProgress";
      sessionId?: string;
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
      metadata?: CondenseMetadata;
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
      sessions: WebviewSessionSummary[];
    }
  | { type: "agentRestoreSessionStart" }
  | { type: "agentRestoreSessionDone" }
  | {
      type: "agentSessionLoaded";
      sessionId: string;
      /** Monotonic transcript mutation counter used to reject stale hydrations. */
      transcriptRevision?: number;
      title: string;
      /** Original visible user prompt, independent of the paginated message tail. */
      originalPrompt?: string;
      mode: string;
      model: string;
      messages: import("./types.js").AgentMessage[];
      /** Absolute index of `messages[0]` in the full persisted transcript (deterministic rehydration ids). */
      messageIndexOffset?: number;
      todos: TodoItem[];
      lastInputTokens: number;
      lastOutputTokens: number;
      /** Durable child results not already represented in persisted messages. */
      backgroundResults?: BackgroundCompletionResult[];
      /** True when this came from automatic startup restore rather than explicit user action. */
      restored?: boolean;
      /** Live tail: blocks of the model response currently streaming (not yet persisted). */
      inFlight?: InFlightAssistantBlock[];
      /** Whether the session's turn is still running at snapshot time. */
      streaming?: boolean;
      /** Whether the session has an interrupted run to resume (persisted runState). */
      interrupted?: boolean;
      /**
       * "focus" marks a hydration triggered by tab/pane focus, where the
       * webview may serve the session from its own caches. All other loads
       * (history load, checkpoint revert, recovered-question resync, webview
       * boot) must be applied.
       */
      origin?: "focus";
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
      /** Absolute index of `messages[0]` in the full persisted transcript (deterministic rehydration ids). */
      messageIndexOffset?: number;
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
      sessions: import("@agentlink/protocol/background-result").BgSessionInfo[];
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
      resultImages?: Array<{ mimeType: string; data: string }>;
      resultDocuments?: Array<{
        name: string;
        mimeType: string;
        data: string;
      }>;
      durationMs: number;
      input?: unknown;
    }
  | {
      type: "agentBgApiRequest";
      sessionId: string;
      requestId: string;
      model: string;
      reasoningEffort: import("./providers/types.js").ReasoningEffort;
      inputTokens: number;
      uncachedInputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      usageEstimated?: boolean;
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
  | { type: "agentBgTodoUpdate"; sessionId: string; todos: TodoItem[] }
  | {
      type: "agentBgWarning";
      sessionId: string;
      message: string;
      retryDelayMs?: number;
      retryAt?: number;
      retryAttempt?: number;
      retryMaxAttempts?: number;
    }
  | { type: "agentBgStatusUpdate"; sessionId: string; message: string }
  | {
      type: "agentBgFinalMarker";
      sessionId: string;
      marker: FinalMessageMarker | null;
    }
  | {
      type: "agentBgCondenseStart";
      sessionId: string;
      isAutomatic: boolean;
    }
  | {
      type: "agentBgCondense";
      sessionId: string;
      prevInputTokens: number;
      newInputTokens: number;
      durationMs: number;
      validationWarnings?: string[];
    }
  | {
      type: "agentBgCondenseError";
      sessionId: string;
      error: string;
      retryable?: boolean;
      code?: string;
      actions?: AgentErrorActions;
    }
  | {
      type: "agentBgInterjection";
      sessionId: string;
      text: string;
      displayText?: string;
      isSlashCommand?: boolean;
      slashCommandLabel?: string;
      displayMedia?: DisplayMedia;
    }
  | {
      type: "agentBgDone";
      sessionId: string;
      parentSessionId?: string | null;
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
      sessionId?: string;
      info: Record<string, string | number>;
      systemPrompt?: string;
      loadedInstructions?: LoadedInstructionDebugInfo[];
    }
  | {
      type: "showBgTranscript";
      sessionId: string;
      task: string;
      messages: unknown[];
      todos: TodoItem[];
    }
  | {
      type: "agentBtwLoading";
      sessionId: string;
      requestId: string;
      question: string;
    }
  | {
      type: "agentBtwProgress";
      sessionId: string;
      requestId: string;
      answer: string;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentBtwResponse";
      sessionId: string;
      requestId: string;
      question: string;
      answer: string;
      error?: boolean;
      cancelled?: boolean;
      tools?: string[];
      warnings?: string[];
      budget?: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupStarted";
      sessionId: string;
      requestId: string;
      input: string;
    }
  | {
      type: "agentWorktreeSetupProgress";
      sessionId: string;
      requestId: string;
      answer: string;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupAwaitingInput";
      sessionId: string;
      requestId: string;
      answer: string;
      conversation: Array<{ role: "user" | "assistant"; text: string }>;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupReady";
      sessionId: string;
      requestId: string;
      answer: string;
      config: WorktreeSetupConfig;
      tools: string[];
      warnings: string[];
      budget: BtwBudget;
    }
  | {
      type: "agentWorktreeSetupLaunching";
      sessionId: string;
      requestId: string;
      config: WorktreeSetupConfig;
    }
  | {
      type: "agentWorktreeSetupResult";
      sessionId: string;
      requestId: string;
      phase: "opened" | "rejected" | "cancelled" | "error";
      message: string;
      config?: WorktreeSetupConfig;
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
    }
  | { type: "agentProviderUsage"; data: ProviderUsageCardData };

export type ChatState =
  import("@agentlink/protocol/chat-state").ChatStateSnapshot;

type ContextBudget = NonNullable<ChatState["contextBudget"]>;

// Non-session UI work still needs a stable ownership bucket for targeted clears.
// Persisted session IDs are UUIDs, so this sentinel cannot collide with one.
const AMBIENT_AGENT_SESSION_ID = "agent";
const MAX_EDITOR_IMAGE_BYTES = 20 * 1024 * 1024;
const EDITOR_IMAGE_EXTENSION_BY_MIME = new Map([
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

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

import {
  getPreviousChunkByUserTurns,
  getTailChunkByUserTurns,
  projectFirstUserPrompt,
  RESTORE_BACKFILL_BATCH_TURNS,
  RESTORE_TAIL_TURNS,
} from "./transcriptChunks.js";

export { getPreviousChunkByUserTurns, getTailChunkByUserTurns };

export type BrowserGatewaySurfaceChangeKind =
  | "background"
  | "mcp"
  | "plugins"
  | "theme";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentLink.chatView";

  private view: vscode.WebviewView | undefined;
  private sessionManager: AgentSessionManager | undefined;
  private chatTabController: ChatTabController | undefined;
  private chatTabHostCoordinator: ChatTabHostCoordinator | undefined;
  private chatTabPanelHost: ChatTabPanelHost | undefined;
  private chatTabControllerListener: { dispose(): void } | undefined;
  private foregroundSessionTransition:
    | {
        previousSessionId: string | undefined;
        nextSessionId?: string;
        promise: Promise<AgentSession>;
      }
    | undefined;
  private outputChannel: vscode.OutputChannel;
  private workspaceHistoryDiagnostic:
    | (() => WorkspaceHistoryLocationDiagnostic)
    | undefined;
  private webviewReady = false;
  private pendingMessages: ExtensionToWebview[] = [];
  private chatTabStartupRestore: Promise<unknown> = Promise.resolve();
  /**
   * True once the current startup restore promise has settled. Gates the
   * provisional tail hydration: once the full restore is done, the complete
   * hydration path is authoritative and a provisional paint is stale noise.
   */
  private chatTabStartupRestoreSettled = true;
  private readonly projectCustomizationRegistry: ProjectCustomizationRegistry;
  private readonly projectMcpHubRegistry: ProjectMcpHubRegistry;
  private readonly mcpAuthCoordinator: McpAuthCoordinator;
  private initialProjectScope: SessionProjectScope | undefined;
  /** Compatibility-only fallback for tests/pre-initialization; production requests lease project hubs. */
  private mcpHub: McpClientHub;
  private askAgentMcpHub: McpClientHub;
  private fileWatchers: vscode.Disposable[] = [];
  private readonly watchedCustomizationProjectIds = new Set<string>();
  private readonly pendingRetrySessionIds = new Set<string>();
  private skillRefreshTail: Promise<void> = Promise.resolve();
  private slashCatalogGlobalGeneration = 0;
  private readonly slashCatalogProjectGenerations = new Map<string, number>();
  private globalSkillWatchersInitialized = false;
  private globalHookWatchersInitialized = false;
  private mainGlobalMcpWatchersInitialized = false;
  private askAgentMcpWatchersInitialized = false;
  private cwd: string = "";
  private readonly formElicitationCoordinator: McpFormElicitationCoordinator;
  private pendingUrlElicitations = new Map<
    string,
    {
      sessionId: string;
      request: McpUrlElicitationRequest;
      resolve: (action: "accept" | "cancel" | "decline") => void;
    }
  >();

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
            memoryTier?: import("@agentlink/protocol/inline-approval").MemoryTier;
            memoryScope?: import("@agentlink/protocol/inline-approval").MemoryScope;
            memoryName?: string;
          },
    ) => void
  >();
  private pendingForwardedApprovals = new Map<
    string,
    {
      sessionId: string;
      kind: ApprovalRequest["kind"];
      respond: (msg: DecisionMessage) => boolean;
    }
  >();
  /**
   * Ids of pending inline approvals that are real file-write review cards
   * (marked via `fileWrite` on the request), eligible for auto-accept when
   * the session is granted covering write authority while they are open.
   */
  private pendingFileWriteApprovalIds = new Set<string>();
  /** In-flight /btw side questions, keyed by requestId, for cancellation. */
  private pendingBtwRequests = new Map<
    string,
    { controller: AbortController; sessionId: string }
  >();
  private pendingWorktreeSetups = new Map<
    string,
    {
      controller: AbortController;
      sessionId: string;
      config?: WorktreeSetupConfig;
      draft?: WorktreeSlashDraft;
      sourcePath?: string;
      conversation: Array<{ role: "user" | "assistant"; text: string }>;
      running?: boolean;
    }
  >();
  private activeApprovalRequests = new Map<string, ApprovalRequest>();
  private approvalSessionById = new Map<string, string>();
  private approvalPresentationById = new Map<
    string,
    { sessionId: string; globallyVisible: boolean }
  >();
  private activeApprovalOrder: string[] = [];
  private visibleApprovalId: string | null = null;
  private pendingQuestions = new Map<
    string,
    (
      response: import("@agentlink/protocol/structured-question").UserQuestionResponse,
    ) => void
  >();
  /** Tracks which pending-question IDs belong to each session, for scoped cancellation on stop */
  private questionSessionIndex = new Map<string, Set<string>>();
  private questionSessionById = new Map<string, string>();
  private readonly questionAttentionById = new Map<
    string,
    { attention: vscode.Disposable; recovered: boolean; sessionId: string }
  >();
  private showPendingInteractionAlert:
    | ((message: string, command: vscode.Command) => vscode.Disposable)
    | undefined;
  /** Tracks which pending-approval IDs belong to each session, for scoped cancellation on stop */
  private approvalSessionIndex = new Map<string, Set<string>>();

  private condenseStartTimes = new Map<string, number>();
  private bgUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private hostHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deltaBufferFlusher: DeltaBufferFlusher;
  private streamDropCounts = {
    sessionMismatch: 0,
    streamingFalse: 0,
  };
  private streamDropLogTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalManager: ApprovalManager | undefined;
  private commandApprovalRequeueHandler:
    | ((sessionId: string) => number)
    | undefined;
  private approvalManagerListener: vscode.Disposable | undefined;
  private approvalStateTransitionDepth = 0;
  private approvalStatePublishPending = false;
  private toolCallTracker: AgentToolCallTracker | undefined;
  private contextJumpTracker: ContextJumpTracker | undefined;
  private sessionOutcomeTelemetry:
    | import("../telemetry/SessionOutcomeTelemetry.js").SessionOutcomeTelemetry
    | undefined;
  private contextHealth: ContextHealthSnapshot = {
    memory: { ...INITIAL_CONTEXT_HEALTH.memory },
    retrieval: { ...INITIAL_CONTEXT_HEALTH.retrieval },
    index: { ...INITIAL_CONTEXT_HEALTH.index },
  };
  private contextHealthGeneration = 0;
  private contextHealthListener:
    | ((health: ContextHealthSnapshot) => void)
    | undefined;
  private memoryHealthProvider:
    | { health(): Promise<MemoryHealthSnapshot> }
    | undefined;
  private memoryInspectionProvider: MemoryInspectionProvider | undefined;
  private retrievalHealthProvider:
    | { health(): Promise<RetrievalHealthSnapshot> }
    | undefined;
  private anthropicProvider: ModelProvider | undefined;
  private openAiCompatibleAuthKeyResolver:
    | ((providerId: string) => string | undefined)
    | undefined;
  private notifyBrowserModelsChanged: (() => void) | undefined;
  private anthropicModelsRefreshInFlight: Promise<void> | undefined;
  private browserGatewayAdminClient:
    | import("../browser-gateway/helper/BrowserGatewayHelperAdminClient.js").BrowserGatewayHelperAdminClient
    | undefined;
  private browserGatewayModelAuthProvider:
    | import("../core/modelAuthProvider.js").CoreModelAuthProvider
    | undefined;
  private pairingPollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private specialBlockPanel: vscode.WebviewPanel | undefined;
  private editorImageTempDirectory: string | undefined;
  private lastMcpStatuses = new Map<
    string,
    Map<string, { status: string; error?: string }>
  >();
  private lastAskAgentMcpStatuses = new Map<
    string,
    { status: string; error?: string }
  >();
  private lastMcpPromptSignatures = new Map<string, string>();
  private mcpConfigVersions = new Map<string, number>();
  private startupMcpRefreshes = new Map<string, Promise<void>>();
  private askAgentMcpConfigVersion = 0;
  private readonly uiEventHub: InMemoryAgentUiEventHub;
  private readonly uiPublisher: AgentUiPublisher;
  private readonly browserGatewaySurfaceChangeEmitter =
    new vscode.EventEmitter<BrowserGatewaySurfaceChangeKind>();
  private browserGatewayThemeSnapshot: BrowserGatewayThemeSnapshot | null =
    null;
  private readonly projectedForegroundStore = new ProjectedForegroundStore();
  private projectedDetectRequest: {
    requestId: string;
    messageId: string;
    assistantText: string;
  } | null = null;
  private projectedLastDetectKey: string | null = null;
  private agentPluginManagerHost: AgentPluginManagerHost | undefined;
  private agentPluginCatalogProvider: AgentPluginCatalogProvider | undefined;
  private mcpPolicyMutationProvider: McpPolicyMutationProvider | undefined;
  private detectRequestInputs = new Map<
    string,
    { messageId: string; assistantText: string; detectKey: string }
  >();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    projectCustomizationRegistry?: ProjectCustomizationRegistry,
    extensionVersion = "unknown",
  ) {
    this.projectCustomizationRegistry =
      projectCustomizationRegistry ?? new ProjectCustomizationRegistry();
    this.outputChannel = vscode.window.createOutputChannel("AgentLink Agent");
    this.mcpAuthCoordinator = new McpAuthCoordinator({
      log: (message) => this.log(message),
    });
    this.uiEventHub = new InMemoryAgentUiEventHub();
    this.uiPublisher = new FanoutAgentUiPublisher([
      new WebviewAgentUiPublisher((message) => {
        this.postMessage(message);
      }),
      this.uiEventHub,
    ]);
    this.formElicitationCoordinator = new McpFormElicitationCoordinator({
      publishRequest: (...args) =>
        this.uiPublisher.publishFormElicitationRequest(...args),
      publishCleared: (...args) =>
        this.uiPublisher.publishFormElicitationCleared(...args),
    });
    this.deltaBufferFlusher = new DeltaBufferFlusher({
      emit: (message) => this.postMessage(message),
      isBackgroundSession: (sessionId) =>
        Boolean(this.sessionManager?.getSession(sessionId)?.background),
    });
    this.mcpHub = new McpClientHub(globalState, extensionVersion, {
      authCoordinator: this.mcpAuthCoordinator,
      hubScope: "compatibility",
    });
    this.askAgentMcpHub = new McpClientHub(globalState, extensionVersion, {
      authCoordinator: this.mcpAuthCoordinator,
      hubScope: "ask-agent",
    });
    void cleanupOrphanedMcpOAuthState(globalState);

    const handleMcpElicitation: NonNullable<McpClientHub["onElicitation"]> = (
      request,
      resolve,
      cancel,
    ) => {
      this.formElicitationCoordinator.enqueue(request, {
        sessionId: this.getAmbientSessionId(),
        resolve,
        cancel,
      });
    };
    this.mcpHub.onElicitation = handleMcpElicitation;
    this.askAgentMcpHub.onElicitation = handleMcpElicitation;

    const handleMcpUrlElicitation: NonNullable<
      McpClientHub["onUrlElicitation"]
    > = (request, resolve) => {
      this.cancelPendingUrlElicitations();
      const sessionId = this.getAmbientSessionId();
      this.pendingUrlElicitations.set(request.id, {
        sessionId,
        request,
        resolve,
      });
      this.uiPublisher.publishUrlElicitationRequest(sessionId, request);
    };
    this.mcpHub.onUrlElicitation = handleMcpUrlElicitation;
    this.askAgentMcpHub.onUrlElicitation = handleMcpUrlElicitation;

    const handleMcpUrlElicitationComplete: NonNullable<
      McpClientHub["onUrlElicitationComplete"]
    > = (serverName, elicitationId) => {
      for (const pending of this.pendingUrlElicitations.values()) {
        if (
          pending.request.serverName === serverName &&
          pending.request.elicitationId === elicitationId
        ) {
          this.resolveUrlElicitation(pending.request.id, "accept");
          return;
        }
      }
    };
    this.mcpHub.onUrlElicitationComplete = handleMcpUrlElicitationComplete;
    this.askAgentMcpHub.onUrlElicitationComplete =
      handleMcpUrlElicitationComplete;
    this.projectMcpHubRegistry = new ProjectMcpHubRegistry({
      createHub: (scope, generation) =>
        new McpClientHub(globalState, extensionVersion, {
          authCoordinator: this.mcpAuthCoordinator,
          hubScope: scope.projectId,
          hubGeneration: generation,
          isConfigCurrent: (config) =>
            this.agentPluginCatalogProvider
              ? isAgentPluginMcpConfigCurrent(config, {
                  requestingScope: scope,
                  pluginCatalog: this.agentPluginCatalogProvider,
                })
              : config.provenance?.kind !== "agent-plugin",
          onBeforeToolCall: (request) =>
            authorizeAgentPluginMcpTool({
              bareToolName: request.bareToolName,
              config: request.config,
              approved: request.approvedByCaller,
            }),
        }),
      loadConfigs: (scope) =>
        this.agentPluginCatalogProvider
          ? loadWorkspaceMcpRuntimeConfigs({
              requestingScope: scope,
              workspaceProjects: this.getWorkspaceMcpProjects(),
              pluginCatalog: this.agentPluginCatalogProvider,
            })
          : loadWorkspaceMcpConfigs(this.getWorkspaceMcpProjects()),
      configureHub: (hub, scope) => {
        hub.onElicitation = handleMcpElicitation;
        hub.onUrlElicitation = handleMcpUrlElicitation;
        hub.onUrlElicitationComplete = handleMcpUrlElicitationComplete;
        hub.onStatusChange = (infos) => {
          if (this.projectMcpHubRegistry.getCurrent(scope)?.hub !== hub) return;
          this.handleMcpStatusChange(infos, scope.projectId);
        };
        hub.onLog = (message) =>
          this.log(`[mcp:${scope.projectId}] ${message}`);
      },
      onError: (error, projectId) =>
        this.log(`[mcp:${projectId}] lifecycle error: ${error}`),
    });
  }

  dispose(): void {
    if (this.editorImageTempDirectory) {
      void fs.promises.rm(this.editorImageTempDirectory, {
        recursive: true,
        force: true,
      });
      this.editorImageTempDirectory = undefined;
    }
    // Reject all pending promises so any awaiting tool calls/question handlers
    // don't stay suspended across view lifecycle.
    for (const [id, resolve] of this.pendingQuestions) {
      resolve({ answers: {}, notes: {} });
      const sessionId = this.questionSessionById.get(id);
      if (sessionId) this.uiPublisher.publishQuestionCleared(sessionId, id);
    }
    this.pendingQuestions.clear();
    this.questionSessionIndex.clear();
    this.questionSessionById.clear();
    for (const { attention } of this.questionAttentionById.values()) {
      attention.dispose();
    }
    this.questionAttentionById.clear();
    for (const request of this.pendingBtwRequests.values()) {
      request.controller.abort();
    }
    this.pendingBtwRequests.clear();
    for (const setup of this.pendingWorktreeSetups.values()) {
      setup.controller.abort();
    }
    this.pendingWorktreeSetups.clear();

    for (const resolve of this.pendingApprovals.values()) {
      resolve("reject");
    }
    this.pendingApprovals.clear();
    this.approvalSessionIndex.clear();
    this.pendingFileWriteApprovalIds.clear();

    for (const [id, pending] of this.pendingForwardedApprovals) {
      // Send a synthetic rejection so the approval chain unblocks.
      pending.respond({
        type: "decision",
        id,
        approvalKind: pending.kind,
        decision: "reject",
      });
    }
    this.pendingForwardedApprovals.clear();
    this.activeApprovalRequests.clear();
    this.approvalSessionById.clear();
    this.approvalPresentationById.clear();
    this.activeApprovalOrder = [];
    this.visibleApprovalId = null;

    this.formElicitationCoordinator.dispose();
    for (const [id, pending] of this.pendingUrlElicitations) {
      pending.resolve("cancel");
      this.uiPublisher.publishUrlElicitationCleared(pending.sessionId, id);
    }
    this.pendingUrlElicitations.clear();

    if (this.hostHeartbeatTimer) {
      clearInterval(this.hostHeartbeatTimer);
      this.hostHeartbeatTimer = null;
    }
    this.outputChannel.dispose();
    this.uiEventHub.dispose();
    this.browserGatewaySurfaceChangeEmitter.dispose();
    this.specialBlockPanel?.dispose();
    this.specialBlockPanel = undefined;
    for (const w of this.fileWatchers) w.dispose();
    this.fileWatchers = [];
    this.approvalManagerListener?.dispose();
    this.chatTabControllerListener?.dispose();
    this.chatTabControllerListener = undefined;
    void this.projectMcpHubRegistry.dispose();
    this.mcpHub?.disconnectAll().catch(() => undefined);
    this.askAgentMcpHub?.disconnectAll().catch(() => undefined);
  }

  getUiEventHub(): ReadableAgentUiEventHub {
    return this.uiEventHub;
  }

  private getAmbientSessionId(): string {
    return (
      this.sessionManager?.getForegroundSession()?.id ??
      AMBIENT_AGENT_SESSION_ID
    );
  }

  onDidChangeBrowserProjectedForeground(
    listener: () => void,
  ): vscode.Disposable {
    return this.projectedForegroundStore.onDidChange(listener);
  }

  onDidChangeBrowserGatewaySurface(
    listener: (kind: BrowserGatewaySurfaceChangeKind) => void,
  ): vscode.Disposable {
    return this.browserGatewaySurfaceChangeEmitter.event(listener);
  }

  notifyBrowserGatewaySurfaceChanged(
    kind: BrowserGatewaySurfaceChangeKind,
  ): void {
    this.browserGatewaySurfaceChangeEmitter.fire(kind);
  }

  getBrowserGatewayThemeSnapshot(): BrowserGatewayThemeSnapshot {
    if (this.view && this.webviewReady && this.browserGatewayThemeSnapshot) {
      return {
        ...this.browserGatewayThemeSnapshot,
        cssVariables: {
          ...this.browserGatewayThemeSnapshot.cssVariables,
          ...this.getBrowserGatewayTerminalSettingsCssVariables(),
        },
      };
    }
    return this.getFallbackThemeSnapshot();
  }

  private updateBrowserGatewayThemeState(update: () => void): void {
    const previous = JSON.stringify(this.getBrowserGatewayThemeSnapshot());
    update();
    const next = JSON.stringify(this.getBrowserGatewayThemeSnapshot());
    if (next !== previous) {
      this.browserGatewaySurfaceChangeEmitter.fire("theme");
    }
  }

  getConfiguredCommandApprovalPolicy(
    projectScope?: SessionProjectScope,
  ): Exclude<CommandApprovalPolicy, "approve-for-me"> {
    const tier = this.getProjectConfiguration(projectScope)?.get<
      "off" | "safe" | "sensitive"
    >("commandAutoApproveTier", "safe");
    return commandApprovalPolicyFromLegacyTier(tier ?? "safe");
  }

  getBrowserCommandApprovalPolicy(): CommandApprovalPolicy {
    return this.getBrowserSessionApprovalMode().commandApprovalPolicy;
  }

  getBrowserSessionApprovalMode(
    sessionId?: string,
    projectScope?: SessionProjectScope,
  ): SessionApprovalMode {
    const effectiveSessionId =
      sessionId ?? this.sessionManager?.getForegroundSession()?.id ?? "agent";
    const configured = this.getConfiguredCommandApprovalPolicy(projectScope);
    return (
      this.sessionManager?.getSessionApprovalMode?.(
        effectiveSessionId,
        configured,
      ) ?? {
        commandApprovalPolicy: configured,
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        executionPreset: "native-manual",
      }
    );
  }

  getBrowserAgentWriteApprovalState(
    sessionId?: string,
  ): "prompt" | "session" | "project" | "global" {
    const effectiveSessionId =
      sessionId ?? this.sessionManager?.getForegroundSession()?.id ?? "agent";
    return (
      this.approvalManager?.getAgentWriteApprovalState(effectiveSessionId) ??
      "prompt"
    );
  }

  setApprovalManager(manager: ApprovalManager): void {
    this.approvalManager = manager;
    this.approvalManagerListener?.dispose();
    this.approvalManagerListener = manager.onDidChange(() => {
      const acceptedMcpRequests =
        this.resolveMcpApprovalsCoveredByServerAuthority();
      if (acceptedMcpRequests > 0) {
        this.log(
          `[approval] auto-accepted ${acceptedMcpRequests} pending MCP approval(s) covered by server approval`,
        );
      }
      this.sendInitialState();
    });
  }

  /**
   * Register the callback (wired to the built-in approval panel) that
   * re-resolves a session's pending command approval cards when its command
   * approval policy changes, so the retried commands run under the new policy.
   */
  setCommandApprovalRequeueHandler(
    handler: (sessionId: string) => number,
  ): void {
    this.commandApprovalRequeueHandler = handler;
  }

  private getSessionApprovalPolicyCoordinator():
    | SessionApprovalPolicyCoordinator
    | undefined {
    if (!this.sessionManager || !this.approvalManager) return undefined;
    return new SessionApprovalPolicyCoordinator({
      getCommandApprovalPolicy: (sessionId, fallback) =>
        this.sessionManager!.getCommandApprovalPolicy(sessionId, fallback),
      setCommandApprovalPolicy: (sessionId, policy) =>
        this.sessionManager!.setCommandApprovalPolicy(sessionId, policy),
      getAgentWriteApprovalState: (sessionId) =>
        this.approvalManager!.getAgentWriteApprovalState(sessionId),
      setAgentWriteApprovalSelection: (sessionId, selection, targetPath) =>
        this.approvalManager!.setAgentWriteApprovalSelection(
          sessionId,
          selection,
          targetPath,
        ),
      resetSessionAgentWriteApproval: (sessionId) =>
        this.approvalManager!.resetSessionAgentWriteApproval(sessionId),
    });
  }

  private withApprovalStateTransition<T>(operation: () => T): T {
    this.approvalStateTransitionDepth += 1;
    try {
      return operation();
    } finally {
      this.finishApprovalStateTransition();
    }
  }

  private async withAsyncApprovalStateTransition<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.approvalStateTransitionDepth += 1;
    try {
      return await operation();
    } finally {
      this.finishApprovalStateTransition();
    }
  }

  private finishApprovalStateTransition(): void {
    this.approvalStateTransitionDepth = Math.max(
      0,
      this.approvalStateTransitionDepth - 1,
    );
    if (this.approvalStateTransitionDepth !== 0) return;
    if (!this.approvalStatePublishPending) return;
    this.approvalStatePublishPending = false;
    this.sendInitialState();
  }

  private setSessionCommandApprovalPolicy(
    sessionId: string,
    policy: CommandApprovalPolicy,
    targetPath?: string,
  ): SessionApprovalPolicyTransitionResult | undefined {
    const coordinator = this.getSessionApprovalPolicyCoordinator();
    if (!coordinator) return undefined;
    const session = this.sessionManager!.getSession?.(sessionId);
    const configured = this.getConfiguredCommandApprovalPolicy(
      session?.projectScope,
    );
    const previousPolicy = this.sessionManager!.getCommandApprovalPolicy(
      sessionId,
      configured,
    );
    return this.withApprovalStateTransition(() => {
      const result = coordinator.setCommandApprovalPolicy(
        sessionId,
        policy,
        configured,
        targetPath,
      );
      if (
        result.ok &&
        policy === "approve-for-me" &&
        previousPolicy !== "approve-for-me"
      ) {
        const requeued = this.commandApprovalRequeueHandler?.(sessionId) ?? 0;
        if (requeued > 0) {
          this.log(
            `[approval] re-resolving ${requeued} pending command approval(s) under Approve for Me`,
          );
        }
        const acceptedWrites =
          this.resolveWriteApprovalsCoveredByAuthority(sessionId);
        if (acceptedWrites > 0) {
          this.log(
            `[approval] auto-accepted ${acceptedWrites} pending write approval(s) under Approve for Me`,
          );
        }
      }
      this.sendInitialState();
      return result;
    });
  }

  private setSessionWriteApproval(
    sessionId: string,
    selection: AgentWriteApprovalSelection,
    targetPath?: string,
  ): SessionApprovalPolicyTransitionResult | undefined {
    const coordinator = this.getSessionApprovalPolicyCoordinator();
    if (!coordinator) return undefined;
    return this.withApprovalStateTransition(() => {
      const result = coordinator.setWriteApproval(
        sessionId,
        selection,
        this.getConfiguredCommandApprovalPolicy(
          this.sessionManager?.getSession?.(sessionId)?.projectScope,
        ),
        targetPath,
      );
      if (result.ok && selection !== "prompt") {
        const acceptedWrites =
          this.resolveWriteApprovalsCoveredByAuthority(sessionId);
        if (acceptedWrites > 0) {
          this.log(
            `[approval] auto-accepted ${acceptedWrites} pending write approval(s) covered by ${selection} write approval`,
          );
        }
      }
      this.sendInitialState();
      return result;
    });
  }

  /**
   * Auto-accept pending file-write review cards whose target the session's
   * write authority now covers (e.g. Approve for Me or a session/project/
   * global write approval was granted while a card was open). Mirrors the
   * auto-approval gate the write path applies before prompting: guardian
   * path-risk eligibility plus agent-write (in-workspace) or file-write
   * (outside-workspace) authorization. Cards not covered stay pending.
   */
  private resolveWriteApprovalsCoveredByAuthority(sessionId: string): number {
    if (!this.approvalManager) return 0;
    const ids = this.approvalSessionIndex.get(sessionId);
    if (!ids || ids.size === 0) return 0;
    let accepted = 0;
    for (const id of ids) {
      if (!this.pendingFileWriteApprovalIds.has(id)) continue;
      const targetPath = this.activeApprovalRequests.get(id)?.targetPath;
      if (!targetPath) continue;
      let target: { absolutePath: string; inWorkspace: boolean };
      try {
        target = resolveAndValidatePath(targetPath);
      } catch {
        continue;
      }
      if (
        isMemoryProtectedPath(target.absolutePath) ||
        !classifyGuardianPathRisk({
          status: "resolved",
          canonicalPath: target.absolutePath,
        }).guardianEligible
      ) {
        continue;
      }
      const covered = target.inWorkspace
        ? this.approvalManager.isAgentWriteApproved(
            sessionId,
            target.absolutePath,
          )
        : this.approvalManager.isFileWriteApproved(
            sessionId,
            target.absolutePath,
          );
      if (!covered) continue;
      const resolve = this.pendingApprovals.get(id);
      if (!resolve) continue;
      this.pendingApprovals.delete(id);
      resolve({ decision: "accept" });
      accepted += 1;
    }
    return accepted;
  }

  private resolveMcpApprovalsCoveredByServerAuthority(): number {
    if (!this.approvalManager) return 0;
    let accepted = 0;
    for (const [id, request] of this.activeApprovalRequests) {
      if (request.kind !== "mcp" || !request.mcpServerName) continue;
      const sessionId = this.approvalSessionById.get(id);
      if (
        !sessionId ||
        !this.approvalManager.isMcpServerApproved(
          sessionId,
          request.mcpServerName,
        )
      ) {
        continue;
      }
      const resolve = this.pendingApprovals.get(id);
      if (!resolve) continue;
      this.pendingApprovals.delete(id);
      resolve({ decision: "allow-once" });
      accepted += 1;
    }
    return accepted;
  }

  private reconcileSessionApprovalAfterModeSwitch(sessionId: string): void {
    const session = this.sessionManager?.getSession?.(sessionId);
    const result =
      this.getSessionApprovalPolicyCoordinator()?.reconcileAfterModeSwitch(
        sessionId,
        this.getConfiguredCommandApprovalPolicy(session?.projectScope),
        session?.projectScope.rootPath,
      );
    if (result && !result.ok) {
      this.log(
        `[approval] disabled Approve for Me after mode switch because session write approval could not be restored (${sessionId})`,
      );
    }
  }

  setToolCallTracker(tracker: AgentToolCallTracker): void {
    this.toolCallTracker = tracker;
  }

  setAgentPluginManagerHost(host: AgentPluginManagerHost): void {
    this.agentPluginManagerHost = host;
    this.mcpPolicyMutationProvider = new DefaultMcpPolicyMutationProvider({
      agentPluginManagerHost: host,
    });
  }

  getMcpPolicyMutationProvider(): McpPolicyMutationProvider | undefined {
    return this.mcpPolicyMutationProvider;
  }

  setAgentPluginCatalogProvider(provider: AgentPluginCatalogProvider): void {
    this.agentPluginCatalogProvider = provider;
  }

  async openAgentPluginManager(projectId?: string): Promise<void> {
    const host = this.agentPluginManagerHost;
    if (!host) {
      void vscode.window.showWarningMessage(
        "Agent Plugins support is unavailable in this AgentLink build.",
      );
      return;
    }
    const projectScope = this.resolveMcpProjectScope(projectId);
    if (projectId && !projectScope) {
      void vscode.window.showErrorMessage(
        "The selected project is unavailable. Choose an available workspace folder.",
      );
      return;
    }
    try {
      this.postMessage({
        type: "agentPluginManagerSnapshot",
        open: true,
        snapshot: await host.getManagerSnapshot(projectScope, {
          readOnly: false,
        }),
      });
    } catch (error) {
      this.log(`[plugins] Failed to open manager: ${String(error)}`);
      void vscode.window.showErrorMessage(
        `Could not open Agent Plugin Manager: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getBrowserAgentPluginManagerSnapshot(projectId: string) {
    const host = this.agentPluginManagerHost;
    if (!host) return undefined;
    const projectScope = this.getAvailableBrowserProjectScope(projectId);
    if (!projectScope) return undefined;
    return host.getManagerSnapshot(projectScope, { readOnly: true });
  }

  async installAgentPluginFromSource(source?: string): Promise<void> {
    const projectScope = this.getCurrentProjectScope();
    const selectedSource =
      source?.trim() ||
      (await this.promptForAgentPluginSource(projectScope?.rootPath));
    if (!selectedSource) return;
    await this.handlePluginSlashCommand(
      `install ${selectedSource}`,
      projectScope,
    );
  }

  setPendingInteractionAlertProvider(
    showAlert: (message: string, command: vscode.Command) => vscode.Disposable,
  ): void {
    this.showPendingInteractionAlert = showAlert;
  }

  setContextUsageTelemetry(
    telemetry: import("../telemetry/ContextUsageTelemetry.js").ContextUsageTelemetry,
  ): void {
    this.contextJumpTracker = new ContextJumpTracker((record) =>
      telemetry.record(record),
    );
  }

  setSessionOutcomeTelemetry(
    telemetry:
      | import("../telemetry/SessionOutcomeTelemetry.js").SessionOutcomeTelemetry
      | undefined,
  ): void {
    this.sessionOutcomeTelemetry = telemetry;
  }

  setMcpAuthTelemetry(
    telemetry:
      | import("../telemetry/McpAuthTelemetry.js").McpAuthTelemetry
      | undefined,
  ): void {
    this.mcpAuthCoordinator.setTelemetry(telemetry);
  }

  setContextHealthListener(
    listener: (health: ContextHealthSnapshot) => void,
  ): void {
    this.contextHealthListener = listener;
    listener(structuredClone(this.contextHealth));
  }

  setContextHealthSources(sources: {
    memory: { health(): Promise<MemoryHealthSnapshot> };
    memoryInspection?: MemoryInspectionProvider;
    retrieval: { health(): Promise<RetrievalHealthSnapshot> };
    semanticIndexEnabled: boolean;
    indexStatus?: ContextIndexHealthInput | null;
  }): void {
    this.memoryHealthProvider = sources.memory;
    this.memoryInspectionProvider = sources.memoryInspection;
    this.retrievalHealthProvider = sources.retrieval;
    this.contextHealth = {
      ...this.contextHealth,
      index: projectIndexHealth(
        sources.indexStatus ?? null,
        sources.semanticIndexEnabled,
      ),
    };
    this.publishContextHealth();
    void this.refreshContextHealth();
  }

  updateContextIndexHealth(
    status: ContextIndexHealthInput | null,
    enabled: boolean,
  ): void {
    this.contextHealth = {
      ...this.contextHealth,
      index: projectIndexHealth(status, enabled),
    };
    this.publishContextHealth();
  }

  private publishContextHealth(): void {
    this.contextHealthListener?.(structuredClone(this.contextHealth));
    this.sendInitialState();
  }

  private getMemoryPanelContext(scope: MemoryToolScope): {
    scope: MemoryToolScope;
    projectId?: string;
  } {
    if (scope === "global") return { scope };
    const projectScope = this.getCurrentProjectScope();
    if (!projectScope || isProjectlessSessionScope(projectScope)) {
      throw new Error("project_scope_unavailable");
    }
    return { scope, projectId: projectScope.projectId };
  }

  private getMemoryPanelAvailableScopes(): MemoryToolScope[] {
    const projectScope = this.getCurrentProjectScope();
    return projectScope && !isProjectlessSessionScope(projectScope)
      ? ["global", "project"]
      : ["global"];
  }

  private async postMemoryPanelSnapshot(
    request: MemoryInspectionQueryRequest,
    options: { requestId?: string; open?: boolean; selectedId?: string } = {},
  ): Promise<void> {
    const provider = this.memoryInspectionProvider;
    const scope = request.scope === "project" ? "project" : "global";
    const availableScopes = this.getMemoryPanelAvailableScopes();
    if (!provider) {
      this.postMessage({
        type: "agentMemoryPanelUpdate",
        requestId: options.requestId,
        open: options.open,
        scope,
        availableScopes,
        error: "Autonomous memory is unavailable.",
      });
      return;
    }

    try {
      const context = this.getMemoryPanelContext(scope);
      const scopedRequest: MemoryInspectionQueryRequest = {
        ...request,
        ...context,
        limit: Math.min(Math.max(Math.trunc(request.limit ?? 100), 1), 200),
      };
      const [query, activity, selected] = await Promise.all([
        provider.query(scopedRequest),
        provider.activity({ ...context, limit: 50 }),
        options.selectedId
          ? provider.detail({ recordId: options.selectedId, ...context })
          : Promise.resolve(undefined),
      ]);
      this.postMessage({
        type: "agentMemoryPanelUpdate",
        requestId: options.requestId,
        open: options.open,
        scope,
        availableScopes,
        snapshot: {
          records: query.result.records,
          total: query.result.total,
          events: activity.events,
          selected: selected?.detail,
          health: query.health,
        },
      });
    } catch {
      this.postMessage({
        type: "agentMemoryPanelUpdate",
        requestId: options.requestId,
        open: options.open,
        scope,
        availableScopes,
        error:
          scope === "project"
            ? "Project memory is unavailable for the current session."
            : "Autonomous memory is unavailable.",
      });
    }
  }

  private async postMemoryPanelDetail(
    recordId: string,
    scope: MemoryToolScope,
    requestId?: string,
  ): Promise<void> {
    const provider = this.memoryInspectionProvider;
    if (!provider) return;
    try {
      const result = await provider.detail({
        recordId,
        ...this.getMemoryPanelContext(scope),
      });
      this.postMessage({
        type: "agentMemoryPanelUpdate",
        requestId,
        scope,
        availableScopes: this.getMemoryPanelAvailableScopes(),
        selected: result.detail,
      });
    } catch {
      this.postMessage({
        type: "agentMemoryPanelUpdate",
        requestId,
        scope,
        availableScopes: this.getMemoryPanelAvailableScopes(),
        error: "The selected memory record is unavailable.",
      });
    }
  }

  private postMemoryPanelMutationError(
    scope: MemoryToolScope,
    requestId: string | undefined,
  ): void {
    this.postMessage({
      type: "agentMemoryPanelUpdate",
      requestId,
      scope,
      availableScopes: this.getMemoryPanelAvailableScopes(),
      error: "The memory operation could not be completed.",
    });
  }

  private async exportMemoryArchive(scope: MemoryToolScope): Promise<void> {
    const provider = this.memoryInspectionProvider;
    if (!provider) return;
    try {
      const exported = await provider.exportArchive(
        this.getMemoryPanelContext(scope),
      );
      const destination = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(os.homedir(), `agentlink-memory-${scope}.json`),
        ),
        filters: { JSON: ["json"] },
        saveLabel: "Export memory archive",
      });
      if (!destination) return;
      await fs.promises.writeFile(
        destination.fsPath,
        `${JSON.stringify(exported.archive, null, 2)}\n`,
        "utf8",
      );
    } catch {
      void vscode.window.showErrorMessage(
        "Could not export autonomous memory.",
      );
    }
  }

  async refreshContextHealth(): Promise<void> {
    const memory = this.memoryHealthProvider;
    const retrieval = this.retrievalHealthProvider;
    if (!memory || !retrieval) return;

    const generation = ++this.contextHealthGeneration;
    const [memoryHealth, retrievalHealth] = await Promise.all([
      memory.health().then(projectMemoryHealth, () => ({
        status: "unavailable" as const,
        retrieval: "unavailable" as const,
        reason: "Autonomous memory is unavailable.",
      })),
      retrieval.health().then(projectRetrievalHealth, () => ({
        status: "unavailable" as const,
        lexical: "unavailable" as const,
        vector: "unavailable" as const,
        structural: "unavailable" as const,
        reason: "The retrieval store is unavailable.",
      })),
    ]);
    if (generation !== this.contextHealthGeneration) return;

    this.contextHealth = {
      memory: memoryHealth,
      retrieval: retrievalHealth,
      index: this.contextHealth.index,
    };
    this.publishContextHealth();
  }

  setBrowserGatewayAdminClient(
    client: import("../browser-gateway/helper/BrowserGatewayHelperAdminClient.js").BrowserGatewayHelperAdminClient,
  ): void {
    this.browserGatewayAdminClient = client;
  }

  setBrowserGatewayModelAuthProvider(
    provider: import("../core/modelAuthProvider.js").CoreModelAuthProvider,
  ): void {
    this.browserGatewayModelAuthProvider = provider;
  }

  /**
   * Register the Anthropic provider so model capabilities can be refreshed
   * lazily (Target A). The provider exposes an optional `listAvailableModels()`.
   */
  setAnthropicProvider(provider: ModelProvider): void {
    this.anthropicProvider = provider;
  }

  setOpenAiCompatibleAuthKeyResolver(
    resolver: (providerId: string) => string | undefined,
  ): void {
    this.openAiCompatibleAuthKeyResolver = resolver;
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
    if (!providerRegistry.isProviderEnabled("anthropic")) return;
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

  getBrowserGatewayModelAuthProvider():
    | import("../core/modelAuthProvider.js").CoreModelAuthProvider
    | undefined {
    return this.browserGatewayModelAuthProvider;
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
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(cwd),
    );
    const workspaceFolderUri = workspaceFolder?.uri.toString();
    this.initialProjectScope = workspaceFolderUri
      ? Object.freeze({
          schemaVersion: 1 as const,
          kind: "project" as const,
          projectId: createWorkspaceProjectId(workspaceFolderUri),
          workspaceFolderUri,
          displayName: workspaceFolder!.name,
          rootPath: cwd,
        })
      : undefined;

    const initialCommands = await this.getCurrentSlashCommands();

    this.mcpHub.onStatusChange = (infos) => {
      this.handleMcpStatusChange(infos);
    };
    this.askAgentMcpHub.onStatusChange = (infos) => {
      this.logMcpStatusTransitions(
        "ask-agent:mcp",
        this.lastAskAgentMcpStatuses,
        infos,
      );
    };
    this.mcpHub.onLog = (message) => {
      this.log(message);
    };
    this.askAgentMcpHub.onLog = (message) => {
      this.log(`[ask-agent] ${message}`);
    };
    const projectScopes = new Map<string, SessionProjectScope>();
    if (this.initialProjectScope) {
      projectScopes.set(
        this.initialProjectScope.projectId,
        this.initialProjectScope,
      );
    }
    for (const project of this.getWorkspaceProjects()) {
      if (project.rootPath) {
        const scope = createSessionProjectScope(project);
        projectScopes.set(scope.projectId, scope);
      }
    }
    await Promise.all(
      Array.from(projectScopes.values()).map((scope) =>
        this.ensureStartupMcpConnection(scope),
      ),
    );
    await this.refreshAskAgentMcpConnections();

    // File watchers for hot reload
    for (const scope of projectScopes.values()) {
      this.setupFileWatchers(scope, true);
    }

    this.log(`[slash] loaded ${initialCommands.length} commands on init`);
    // Re-send after async init completes in case webview opened during init
    void this.sendModesUpdate();
    void this.sendSlashCommands();
  }

  getProjectMcpHubRegistry(): ProjectMcpHubRegistry {
    return this.projectMcpHubRegistry;
  }

  /** Returns the current foreground/default project hub, or the compatibility fallback. */
  getMcpHub(): McpClientHub {
    return this.getCurrentProjectMcpHub() ?? this.mcpHub;
  }

  /** Returns the Ask Agent MCP client hub (always defined, may not yet be connected). */
  getAskAgentMcpHub(): McpClientHub {
    return this.askAgentMcpHub;
  }

  private handleMcpStatusChange(
    infos: McpServerInfo[],
    projectId?: string,
  ): void {
    const foregroundScope = this.getCurrentProjectScope();
    const foregroundProjectId = foregroundScope?.projectId;
    const isForegroundProject = !projectId || projectId === foregroundProjectId;
    const statusKey = projectId ?? "compatibility";
    const previousStatuses =
      this.lastMcpStatuses.get(statusKey) ??
      new Map<string, { status: string; error?: string }>();
    this.lastMcpStatuses.set(statusKey, previousStatuses);
    this.logMcpStatusTransitions(
      projectId ? `mcp:${projectId}` : "mcp",
      previousStatuses,
      infos,
    );
    if (isForegroundProject) {
      this.browserGatewaySurfaceChangeEmitter.fire("mcp");
      void this.postMcpManagerSnapshot({
        profile: "main",
        infos,
        projectScope: foregroundScope,
      });
    }

    const promptSignature = this.buildMcpPromptSignature(infos);
    if (promptSignature !== this.lastMcpPromptSignatures.get(statusKey)) {
      this.lastMcpPromptSignatures.set(statusKey, promptSignature);
      void this.rebuildSessionSystemPromptsForMcp(projectId);
    }
  }

  private logMcpStatusTransitions(
    prefix: string,
    previousStatuses: Map<string, { status: string; error?: string }>,
    infos: McpServerInfo[],
  ): void {
    if (infos.length === 0) {
      this.log(`[${prefix}] status update: no configured servers`);
      return;
    }

    const transitions: string[] = [];
    for (const info of infos) {
      const prev = previousStatuses.get(info.name);
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
      previousStatuses.set(info.name, {
        status: info.status,
        error: info.error,
      });
    }

    if (transitions.length > 0) {
      this.log(`[${prefix}] status transition(s): ${transitions.join(" | ")}`);
    } else {
      const snapshot = infos
        .map((i) => `${i.name}=${i.status}${i.error ? `(${i.error})` : ""}`)
        .join(", ");
      this.log(`[${prefix}] status update (no transition): ${snapshot}`);
    }
  }

  private buildMcpPromptSignature(infos: McpServerInfo[]): string {
    return infos
      .filter((info) => info.status === "connected" && info.toolCount > 0)
      .map((info) => {
        const tools = info.tools
          .map((tool) => `${tool.name}:${tool.description ?? ""}`)
          .sort()
          .join(",");
        return `${info.name}:${info.toolCount}:${tools}`;
      })
      .sort()
      .join("|");
  }

  private async rebuildSessionSystemPromptsForMcp(
    projectId?: string,
  ): Promise<void> {
    if (!this.sessionManager) return;
    try {
      await this.sessionManager.rebuildSystemPrompts(projectId);
      this.log("[mcp] Rebuilt system prompt after MCP availability change");
    } catch (err) {
      this.log(`[mcp] Failed to rebuild system prompt: ${err}`);
    }
  }

  private bumpMcpConfigVersion(projectId: string): void {
    this.mcpConfigVersions.set(
      projectId,
      (this.mcpConfigVersions.get(projectId) ?? 0) + 1,
    );
  }

  private async refreshMcpConnections(
    options?: McpConnectOptions,
    explicitScope?: SessionProjectScope,
  ): Promise<void> {
    const scope = explicitScope ?? this.getCurrentProjectScope();
    if (!scope?.rootPath) return;
    try {
      const generation = await this.projectMcpHubRegistry.reload(
        scope,
        options,
      );
      this.log(
        `[mcp:${scope.projectId}] activated generation ${generation.generation}`,
      );
      this.handleMcpStatusChange(
        generation.hub.getServerInfos(),
        scope.projectId,
      );
    } catch (err) {
      this.log(`[mcp:${scope.projectId}] connection error: ${err}`);
    }
  }

  private ensureStartupMcpConnection(
    scope: SessionProjectScope,
  ): Promise<void> {
    const current = this.projectMcpHubRegistry.getCurrent(scope);
    if (current && current.generation > 0) return Promise.resolve();
    const existing = this.startupMcpRefreshes.get(scope.projectId);
    if (existing) return existing;
    const refresh = this.refreshMcpConnections(
      { trigger: "startup" },
      scope,
    ).finally(() => {
      if (this.startupMcpRefreshes.get(scope.projectId) === refresh) {
        this.startupMcpRefreshes.delete(scope.projectId);
      }
    });
    this.startupMcpRefreshes.set(scope.projectId, refresh);
    return refresh;
  }

  async refreshAllPluginMcpConnections(): Promise<void> {
    await this.refreshAllWorkspaceMcpConnections({
      interactiveForNewServers: false,
      trigger: "plugin-refresh",
    });
  }

  private async refreshAllWorkspaceMcpConnections(
    options?: McpConnectOptions,
  ): Promise<void> {
    await Promise.all(
      this.getWorkspaceProjects().flatMap((project) => {
        if (!project.rootPath || project.availability.status !== "available")
          return [];
        const projectScope = createSessionProjectScope(project);
        this.bumpMcpConfigVersion(projectScope.projectId);
        return [this.refreshMcpConnections(options, projectScope)];
      }),
    );
  }

  private getCurrentProjectScope(): SessionProjectScope | undefined {
    return (
      this.sessionManager?.getForegroundSession()?.projectScope ??
      this.sessionManager?.getDefaultProjectScope?.() ??
      this.initialProjectScope
    );
  }

  private getMcpManagerProjects(): NonNullable<McpConfigSnapshot["projects"]> {
    return this.getWorkspaceProjects().map((project) => ({
      projectId: project.id,
      displayName: project.name,
      availability:
        project.availability.status === "available"
          ? ("available" as const)
          : ("unavailable" as const),
    }));
  }

  private getWorkspaceMcpProjects(): Array<{
    projectId: string;
    displayName: string;
    rootPath: string;
  }> {
    const projects = this.getWorkspaceProjects().flatMap((project) =>
      project.availability.status === "available" && project.rootPath
        ? [
            {
              projectId: project.id,
              displayName: project.name,
              rootPath: project.rootPath,
            },
          ]
        : [],
    );
    if (projects.length > 0) return projects;
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => {
        let rootPath = folder.uri.fsPath;
        try {
          rootPath = require("fs").realpathSync.native(rootPath);
        } catch {
          // Keep the URI-backed path; the config reader reports availability.
        }
        const workspaceFolderUri = folder.uri.toString();
        return {
          projectId: createWorkspaceProjectId(workspaceFolderUri),
          displayName: folder.name,
          rootPath,
        };
      });
  }

  private resolveMcpProjectScope(
    projectId?: string,
  ): SessionProjectScope | undefined {
    return projectId
      ? this.getAvailableBrowserProjectScope(projectId)
      : this.getCurrentProjectScope();
  }

  private getProjectConfiguration(
    scope = this.getCurrentProjectScope(),
  ): vscode.WorkspaceConfiguration | undefined {
    if (scope) {
      return vscode.workspace.getConfiguration(
        "agentlink",
        vscode.Uri.parse(scope.workspaceFolderUri),
      );
    }
    // Compatibility for provider-only tests/legacy doubles. Production sessions
    // always carry projectScope and unavailable sessions cannot reach send/tools.
    return this.sessionManager?.getForegroundSession()
      ? vscode.workspace.getConfiguration("agentlink")
      : undefined;
  }

  private getCurrentProjectConfiguration():
    | vscode.WorkspaceConfiguration
    | undefined {
    return this.getProjectConfiguration();
  }

  private getCurrentProjectMcpHub(
    scope = this.getCurrentProjectScope(),
  ): McpClientHub | undefined {
    return scope
      ? this.projectMcpHubRegistry.getCurrent(scope)?.hub
      : undefined;
  }

  private getProjectMcpStatusInfos(
    hub: McpClientHub,
    projectId: string,
    infos = hub.getServerInfos(),
  ): McpServerInfo[] {
    return infos.flatMap((info) => {
      const config = hub.getServerConfig(info.name);
      if (
        config?.sourceProjectIds &&
        !config.sourceProjectIds.includes(projectId)
      ) {
        return [];
      }
      return [
        {
          ...info,
          name:
            config?.provenance?.kind === "agent-plugin"
              ? info.name
              : (config?.sourceServerName ?? info.name),
        },
      ];
    });
  }

  private resolveProjectMcpRuntimeServerName(
    hub: McpClientHub,
    projectId: string,
    sourceServerName: string,
  ): string | undefined {
    return hub.getServerInfos().find((info) => {
      const config = hub.getServerConfig(info.name);
      return (
        (info.name === sourceServerName ||
          (config?.sourceServerName ?? info.name) === sourceServerName) &&
        (!config?.sourceProjectIds ||
          config.sourceProjectIds.includes(projectId))
      );
    })?.name;
  }

  private async refreshAskAgentMcpConnections(
    options: McpConnectOptions = { trigger: "ask-agent-refresh" },
  ): Promise<void> {
    if (!this.askAgentMcpHub) return;
    try {
      const configs = await loadAskAgentMcpConfigs();
      await this.askAgentMcpHub.connect(configs, {
        interactiveForNewServers: options?.interactiveForNewServers,
      });
      this.log(`[ask-agent:mcp] connected ${configs.length} server(s)`);
    } catch (err) {
      this.log(`[ask-agent:mcp] connection error: ${err}`);
    }
  }

  private async buildMcpConfigSnapshot(
    profile: McpManagerProfile,
    statusInfos?: McpServerInfo[],
    projectScope = profile === "main"
      ? this.getCurrentProjectScope()
      : undefined,
    mainHub = projectScope
      ? this.getCurrentProjectMcpHub(projectScope)
      : undefined,
  ): Promise<McpConfigSnapshot> {
    const rawInfos =
      statusInfos ??
      (profile === "ask-agent"
        ? (this.askAgentMcpHub?.getServerInfos() ?? [])
        : (mainHub ?? this.mcpHub).getServerInfos());
    const infos =
      profile === "main" && projectScope
        ? this.getProjectMcpStatusInfos(
            mainHub ?? this.mcpHub,
            projectScope.projectId,
            rawInfos,
          )
        : rawInfos;
    const projectRoot = projectScope?.rootPath ?? this.cwd;
    const sources =
      profile === "ask-agent"
        ? await getMcpConfigSources("ask-agent")
        : await getMcpConfigSources("main", projectRoot);
    const nativeEntries =
      profile === "ask-agent"
        ? await buildMcpConfigEntries("ask-agent")
        : await buildMcpConfigEntries("main", projectRoot);
    const pluginEntries =
      profile === "main" && projectScope && this.agentPluginCatalogProvider
        ? await this.buildAgentPluginMcpManagerEntries(projectScope)
        : [];
    const entries = [...nativeEntries, ...pluginEntries];

    return {
      profile,
      ...(profile === "main" && projectScope
        ? {
            project: {
              projectId: projectScope.projectId,
              displayName: projectScope.displayName,
              availability: projectScope.rootPath
                ? ("available" as const)
                : ("unavailable" as const),
            },
            projects: this.getMcpManagerProjects(),
          }
        : {}),
      version:
        profile === "ask-agent"
          ? this.askAgentMcpConfigVersion
          : (this.mcpConfigVersions.get(
              projectScope?.projectId ?? "compatibility",
            ) ?? 0),
      revision: buildMcpConfigRevision(sources),
      sources,
      entries,
      statusInfos: infos,
      capabilities: {
        canEditConfig: true,
        canOpenRawConfig: true,
        canReconnect: true,
        canReauthenticate: true,
        canDisable: true,
        canUseProjectConfig: profile === "main",
        canWriteSecrets: true,
        canConfigureLocalProcess: true,
      },
    };
  }

  private async buildAgentPluginMcpManagerEntries(
    projectScope: Readonly<SessionProjectScope>,
  ): Promise<McpConfigSnapshot["entries"]> {
    if (!this.agentPluginCatalogProvider) return [];
    const catalog =
      await this.agentPluginCatalogProvider.getSnapshot(projectScope);
    return catalog.mcpServers.flatMap((entry) => {
      if (entry.server.type !== "stdio") return [];
      const runtimeServerName = agentPluginMcpRuntimeServerName(
        entry.installInstanceId,
        entry.portableServerName,
      );
      const target = {
        kind: "agent-plugin-overlay" as const,
        installInstanceId: entry.installInstanceId,
        packageDigest: entry.packageDigest,
        declaredServerName: entry.portableServerName,
        runtimeServerName,
        scope: entry.scope.kind,
        projectId: projectScope.projectId,
      };
      const result: McpConfigSnapshot["entries"][number] = {
        name: runtimeServerName,
        config: {
          name: runtimeServerName,
          type: "stdio" as const,
          command: entry.server.command,
          args: entry.server.args ? [...entry.server.args] : undefined,
          toolPolicy: entry.policy.toolPolicy ?? "ask",
          toolDisclosure: entry.policy.toolDisclosure ?? "auto",
          supportsParallelToolCalls:
            entry.policy.supportsParallelToolCalls ?? false,
          allowedTools: entry.policy.allowedTools
            ? [...entry.policy.allowedTools]
            : undefined,
          disabled: entry.policy.disabled ?? false,
        },
        mutationTarget: target,
        mutationRevision: `plugin-registry:${catalog.registryRevision}`,
        mutationCapabilities: {
          connectionFields: false,
          policyFields: true,
          remove: false,
          openRaw: false,
        },
        sourceIds: [],
        editableScopes: [entry.scope.kind],
        preferredEditScope: entry.scope.kind,
        inherited: entry.scope.kind === "global",
        hasSecrets: false,
        writableOverrideScopes: [entry.scope.kind],
        envKeys: [],
        headerKeys: [],
      };
      return [result];
    });
  }

  private async postMcpManagerSnapshot(options: {
    profile: McpManagerProfile;
    open?: boolean;
    view?: McpManagerView;
    infos?: McpServerInfo[];
    projectScope?: SessionProjectScope;
    mainHub?: McpClientHub;
  }): Promise<void> {
    const projectScope =
      options.profile === "main"
        ? (options.projectScope ?? this.getCurrentProjectScope())
        : undefined;
    const mainHub =
      options.profile === "main"
        ? (options.mainHub ?? this.getCurrentProjectMcpHub(projectScope))
        : undefined;
    const infos =
      options.infos ??
      (options.profile === "ask-agent"
        ? (this.askAgentMcpHub?.getServerInfos() ?? [])
        : (mainHub ?? this.mcpHub).getServerInfos());
    const configSnapshot = await this.buildMcpConfigSnapshot(
      options.profile,
      infos,
      projectScope,
      mainHub,
    );
    this.postMessage({
      type: "agentMcpStatus",
      infos: configSnapshot.statusInfos,
      open: options.open,
      view: options.view,
      configSnapshot,
    } as ExtensionToWebview);
  }

  private async openRawMcpConfig(
    profile: McpManagerProfile,
    scope: McpManagerScope,
    projectScope = profile === "main"
      ? this.getCurrentProjectScope()
      : undefined,
  ): Promise<void> {
    if (profile === "ask-agent") {
      if (scope !== "ask-agent-global") return;
      await this.openMcpConfigFile(getAskAgentMcpConfigFilePaths().global);
      return;
    }
    if (scope !== "global" && scope !== "project") return;
    await this.openMcpConfig(scope, projectScope);
  }

  private async openMcpConfigFile(filePath: string): Promise<void> {
    const fs = require("fs");
    const pathMod = require("path");
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

  private async openMcpConfig(
    scope: "project" | "global",
    projectScope = this.getCurrentProjectScope(),
  ): Promise<void> {
    const projectRoot = projectScope?.rootPath;
    if (!projectRoot) return;
    const paths = getMcpConfigFilePaths(projectRoot);
    const filePath = scope === "global" ? paths.global : paths.project;

    await this.openMcpConfigFile(filePath);
  }

  /** Called by the tool dispatcher when the agent requests a mode switch. */
  public async handleModeSwitch(
    mode: string,
    reason?: string,
    silent?: boolean,
    sessionId?: string,
  ): Promise<{
    approved: boolean;
    mode: string;
    followUp?: string;
    rejectionReason?: string;
  }> {
    const requestedBy =
      reason && reason.trim().length > 0 ? reason.trim() : "agent";

    let followUp: string | undefined;
    const foregroundSession = this.sessionManager?.getForegroundSession();
    const targetSessionId = sessionId ?? foregroundSession?.id;
    const targetSession = targetSessionId
      ? (this.sessionManager?.getSession?.(targetSessionId) ??
        (foregroundSession?.id === targetSessionId
          ? foregroundSession
          : undefined))
      : undefined;
    const approvalMode =
      !silent && targetSessionId
        ? this.sessionManager?.getSessionApprovalMode(
            targetSessionId,
            this.getConfiguredCommandApprovalPolicy(
              this.sessionManager?.getSession?.(targetSessionId)?.projectScope,
            ),
          )
        : undefined;
    const approveForMe =
      approvalMode?.commandApprovalPolicy === "approve-for-me" &&
      approvalMode.approvalPolicy === "on-request" &&
      approvalMode.approvalReviewer === "auto-review" &&
      approvalMode.executionPreset === "workspace-write";
    const requiresInitialArchitectReview = Boolean(
      targetSessionId &&
      this.sessionManager?.requiresInitialArchitectReview?.(
        targetSessionId,
        mode,
      ),
    );
    // `silent` is host-owned evidence that the user chose an ask_user option
    // carrying a modeSwitch map. The model cannot set it on switch_mode.
    const hasExplicitUserConsent = silent === true;

    if (
      !hasExplicitUserConsent &&
      (!approveForMe || requiresInitialArchitectReview)
    ) {
      try {
        const approval = await this.requestApproval(
          {
            id: `mode-switch-${randomUUID()}`,
            kind: "mode-switch",
            title: `Switch to "${mode}" mode`,
            detail: requestedBy,
            choices: [
              { label: "Allow", value: "run-once", isPrimary: true },
              { label: "Reject", value: "reject", isDanger: true },
            ],
          },
          targetSessionId,
        );

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
            sessionId: targetSessionId ?? "agent",
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
      if (!targetSessionId) {
        // No active session yet — fall back to creating a new session in target mode.
        this.postMessage({ type: "agentModeSwitchRequest", mode, reason });
        return { approved: true, mode, followUp };
      }
      const previousMode = targetSession?.mode;
      const session = await this.withAsyncApprovalStateTransition(async () => {
        const switched = await this.sessionManager!.switchSessionMode(
          targetSessionId,
          mode,
          {
            initialArchitectReviewApproved:
              hasExplicitUserConsent || requiresInitialArchitectReview,
          },
        );
        if (!switched) return null;
        if (previousMode && previousMode !== switched.mode) {
          this.recordSurfaceChange(switched, {
            mode: { previousMode, mode: switched.mode },
          });
        }
        this.reconcileSessionApprovalAfterModeSwitch(switched.id);
        if (!switched.background) {
          this.sessionManager!.queueModeSwitchResume(switched.id, mode, {
            reason,
            followUp,
          });
        }
        this.sendInitialState();
        return switched;
      });
      if (!session) {
        // Don't report success: the engine ends the turn after an approved
        // switch and relies on a queued resume that was never queued here.
        const rejectionReason = `Mode switch to "${mode}" failed: session no longer exists`;
        this.log(`[mode] ${rejectionReason} (session ${targetSessionId})`);
        return { approved: false, mode, followUp, rejectionReason };
      }
      const suffix = followUp?.trim() ? ` | ${followUp.trim()}` : "";
      const tag = silent ? " (silent)" : "";
      this.log(
        `[mode] switched ${session.background ? "background" : "foreground"} session ${session.id} to ${mode}${tag}${suffix}`,
      );
      return { approved: true, mode, followUp };
    } catch (err) {
      // Don't report success: the engine ends the turn after an approved
      // switch and relies on a queued resume that was never queued here.
      const rejectionReason = `Mode switch to "${mode}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.log(`[mode] failed to switch mode in-place: ${err}`);
      return { approved: false, mode, followUp, rejectionReason };
    }
  }

  /**
   * Forward a rich approval request (from ApprovalPanelProvider) to the chat webview.
   * Renders the actual CommandCard/WriteCard/RenameCard/PathCard components inline.
   */
  public forwardApproval(
    forwarded: { sessionId: string; request: ApprovalRequest },
    respond: (msg: DecisionMessage) => boolean,
  ): void {
    const { sessionId, request } = forwarded;
    this.pendingForwardedApprovals.set(request.id, {
      sessionId,
      kind: request.kind,
      respond,
    });
    this.showApprovalRequest(sessionId, request);
  }

  public cancelForwardedApproval(sessionId: string, id: string): void {
    this.pendingForwardedApprovals.delete(id);
    this.clearApprovalRequest(sessionId, id);
  }

  private showApprovalRequest(
    sessionId: string,
    request: ApprovalRequest,
  ): void {
    if (!this.activeApprovalRequests.has(request.id)) {
      this.activeApprovalOrder.push(request.id);
      this.recordApprovalInterruption(sessionId, request);
    }
    this.activeApprovalRequests.set(request.id, request);
    this.approvalSessionById.set(request.id, sessionId);
    const presentation = this.getApprovalPresentation(sessionId, request);
    this.approvalPresentationById.set(request.id, presentation);
    this.visibleApprovalId = request.id;
    if (presentation.globallyVisible) {
      this.uiPublisher.publishApproval(
        presentation.sessionId,
        request,
        presentation,
      );
    } else {
      this.uiPublisher.publishApproval(presentation.sessionId, request);
    }
  }

  private recordApprovalInterruption(
    sessionId: string,
    request: ApprovalRequest,
  ): void {
    if (!this.sessionOutcomeTelemetry) return;
    const session = this.sessionManager?.getSession(sessionId);
    if (!session) return;
    const approvalMode = this.sessionManager?.getSessionApprovalMode(
      sessionId,
      this.getConfiguredCommandApprovalPolicy(session.projectScope),
    );
    if (
      approvalMode?.commandApprovalPolicy !== "approve-for-me" ||
      approvalMode.approvalPolicy !== "on-request" ||
      approvalMode.approvalReviewer !== "auto-review" ||
      approvalMode.executionPreset !== "workspace-write"
    ) {
      return;
    }

    const review = request.commandReview ?? request.networkReview;
    try {
      this.sessionOutcomeTelemetry.record({
        type: "approval_interruption",
        sessionId,
        background: session.background === true,
        mode: session.mode,
        projectId: session.projectScope?.projectId,
        approvalKind: request.kind,
        reason: classifyApprovalInterruptionReason(request),
        guardianStatus: review?.status,
        guardianOutcome: review?.outcome,
        risk: review?.risk,
        permissionIntent: request.security?.permissionIntent,
        authorityReason: request.security?.authorityReason,
        routeReason: request.security?.routeReason,
      });
    } catch (err) {
      this.log(
        `[session-outcome] approval interruption record failed: ${String(err)}`,
      );
    }
  }

  private clearApprovalRequest(sessionId: string, id: string): void {
    if (this.approvalSessionById.get(id) !== sessionId) return;
    const presentation = this.approvalPresentationById.get(id);
    const wasVisible = this.visibleApprovalId === id;
    this.activeApprovalRequests.delete(id);
    this.approvalSessionById.delete(id);
    this.approvalPresentationById.delete(id);
    this.activeApprovalOrder = this.activeApprovalOrder.filter(
      (approvalId) => approvalId !== id,
    );
    if (presentation?.globallyVisible) {
      this.uiPublisher.publishApprovalIdle(
        presentation.sessionId,
        id,
        presentation,
      );
    } else {
      this.uiPublisher.publishApprovalIdle(
        presentation?.sessionId ?? sessionId,
        id,
      );
    }
    if (wasVisible) {
      this.visibleApprovalId = null;
      this.publishVisibleApproval();
    }
  }

  private getApprovalPresentation(
    sessionId: string,
    request: ApprovalRequest,
  ): { sessionId: string; globallyVisible: boolean } {
    if (!request.backgroundTask) return { sessionId, globallyVisible: false };
    const backgroundSession = this.sessionManager?.getSession(sessionId);
    const rootSessionId = backgroundSession?.fleetMetadata?.rootSessionId;
    const rootSession = rootSessionId
      ? this.sessionManager?.getSession(rootSessionId)
      : undefined;
    return rootSession &&
      !rootSession.background &&
      (!this.chatTabController ||
        this.chatTabController.getTabForSession(rootSession.id))
      ? { sessionId: rootSession.id, globallyVisible: false }
      : { sessionId, globallyVisible: true };
  }

  private publishVisibleApproval(): void {
    for (let i = this.activeApprovalOrder.length - 1; i >= 0; i -= 1) {
      const id = this.activeApprovalOrder[i];
      const request = this.activeApprovalRequests.get(id);
      const sessionId = this.approvalSessionById.get(id);
      if (!request || !sessionId) continue;
      const presentation = this.getApprovalPresentation(sessionId, request);
      this.approvalPresentationById.set(id, presentation);
      this.visibleApprovalId = id;
      if (presentation.globallyVisible) {
        this.uiPublisher.publishApproval(
          presentation.sessionId,
          request,
          presentation,
        );
      } else {
        this.uiPublisher.publishApproval(presentation.sessionId, request);
      }
      return;
    }

    this.visibleApprovalId = null;
  }

  /** Ask the selected provider's fast model for a bounded, context-aware rule. */
  public async suggestRegexForCommand(args: {
    subCommand: string;
    fullCommand: string;
    sessionId?: string;
  }): Promise<string> {
    const fg = args.sessionId
      ? this.sessionManager?.getSession(args.sessionId)
      : this.sessionManager?.getForegroundSession();
    const foregroundModel =
      fg?.model ??
      this.sessionManager?.getConfig().model ??
      "claude-sonnet-4-6";
    const provider = providerRegistry.tryResolveProvider(foregroundModel);
    if (!provider) {
      throw new Error(`No provider available for model "${foregroundModel}"`);
    }

    const { systemPrompt, userPrompt, requiredVariants } =
      await buildCommandRegexSuggestionPrompt({ ...args, session: fg });
    const model = getProviderAuxiliaryModel(provider, foregroundModel);
    const permit = await providerRegistry.requestScheduler.acquire(
      provider.id,
      "interactive",
      fg?.abortSignal,
    );
    let result: Awaited<ReturnType<ModelProvider["complete"]>>;
    try {
      result = await provider.complete({
        model,
        systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 384,
        temperature: 0,
        reasoningEffort: "none",
        signal: fg?.abortSignal,
      });
    } finally {
      permit.release();
    }

    const pattern = extractRegexPattern(result.text);
    if (!pattern) {
      throw new Error("Model returned no usable regex");
    }
    validateSuggestedCommandRegex(pattern, args.subCommand, requiredVariants);
    return pattern;
  }

  private async handleSuggestRegex(args: {
    requestId: string;
    subCommand: string;
    fullCommand: string;
    sessionId?: string;
    connection?: ChatPaneConnection;
  }): Promise<void> {
    const reply = (message: ExtensionToWebview) =>
      args.connection
        ? args.connection.postMessage(message)
        : this.postMessage(message);
    try {
      const pattern = await this.suggestRegexForCommand({
        subCommand: args.subCommand,
        fullCommand: args.fullCommand,
        sessionId: args.sessionId,
      });
      reply({
        type: "regexSuggestion",
        requestId: args.requestId,
        pattern,
      } as ExtensionToWebview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[suggest-regex] failed: ${message}`);
      reply({
        type: "regexSuggestion",
        requestId: args.requestId,
        error: message,
      } as ExtensionToWebview);
    }
  }

  /**
   * Polish a composer draft (spelling, grammar, wording) with the selected
   * provider's fast model, preserving the draft's meaning and structure.
   */
  public async polishPrompt(args: {
    draft: string;
    sessionId?: string;
  }): Promise<string> {
    const fg = args.sessionId
      ? this.sessionManager?.getSession(args.sessionId)
      : this.sessionManager?.getForegroundSession();
    const foregroundModel =
      fg?.model ??
      this.sessionManager?.getConfig().model ??
      "claude-sonnet-4-6";
    const provider = providerRegistry.tryResolveProvider(foregroundModel);
    if (!provider) {
      throw new Error(`No provider available for model "${foregroundModel}"`);
    }

    const { systemPrompt, userPrompt } = buildPromptPolishPrompt(args.draft);
    const model = getProviderAuxiliaryModel(provider, foregroundModel);
    const permit = await providerRegistry.requestScheduler.acquire(
      provider.id,
      "interactive",
      fg?.abortSignal,
    );
    let result: Awaited<ReturnType<ModelProvider["complete"]>>;
    try {
      result = await provider.complete({
        model,
        systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: Math.min(4096, 512 + Math.ceil(args.draft.length / 3)),
        temperature: 0,
        reasoningEffort: "none",
        signal: fg?.abortSignal,
      });
    } finally {
      permit.release();
    }

    const polished = extractPolishedPrompt(result.text);
    if (!polished) {
      throw new Error("Model returned no usable text");
    }
    return polished;
  }

  private async handlePolishPrompt(args: {
    requestId: string;
    draft: string;
    sessionId?: string;
    connection?: ChatPaneConnection;
  }): Promise<void> {
    const reply = (message: ExtensionToWebview) =>
      args.connection
        ? args.connection.postMessage(message)
        : this.postMessage(message);
    try {
      const polished = await this.polishPrompt({
        draft: args.draft,
        sessionId: args.sessionId,
      });
      reply({
        type: "promptPolishResult",
        requestId: args.requestId,
        polished,
      } as ExtensionToWebview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[polish-prompt] failed: ${message}`);
      reply({
        type: "promptPolishResult",
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
      kind:
        | "mcp"
        | "write"
        | "rename"
        | "command"
        | "mode-switch"
        | "memory"
        | "worktree"
        | "hook";
      title: string;
      detail?: string;
      mcpServerName?: string;
      mcpToolName?: string;
      toolOrigin?: "mcp" | "acp";
      choices: Array<{
        label: string;
        value: string;
        isPrimary?: boolean;
        isDanger?: boolean;
      }>;
      id?: string;
      backgroundTask?: string;
      targetPath?: string;
      commandText?: string;
      commandReason?: string;
      humanOnlyReason?: string;
      cwd?: string;
      fileWrite?: { operation: "create" | "modify"; outsideWorkspace: boolean };
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
        memoryTier?: import("@agentlink/protocol/inline-approval").MemoryTier;
        memoryScope?: import("@agentlink/protocol/inline-approval").MemoryScope;
        memoryName?: string;
      }
  > {
    const id = request.id ?? randomUUID();
    const ownerSessionId = sessionId?.trim();
    if (!ownerSessionId) {
      throw new Error("Built-in agent approval requests require a sessionId.");
    }

    // Build an ApprovalRequest for the rich card system
    const approvalRequest = this.buildApprovalRequest(
      id,
      request,
      ownerSessionId,
    );

    const sessionSet =
      this.approvalSessionIndex.get(ownerSessionId) ?? new Set();
    sessionSet.add(id);
    this.approvalSessionIndex.set(ownerSessionId, sessionSet);
    if (request.kind === "write" && request.fileWrite) {
      this.pendingFileWriteApprovalIds.add(id);
    }

    return new Promise((resolve) => {
      this.pendingApprovals.set(id, (result) => {
        this.clearApprovalRequest(ownerSessionId, id);
        this.approvalSessionIndex.get(ownerSessionId)?.delete(id);
        this.pendingFileWriteApprovalIds.delete(id);
        resolve(result);
      });
      this.showApprovalRequest(ownerSessionId, approvalRequest);
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
      mcpServerName?: string;
      mcpToolName?: string;
      toolOrigin?: "mcp" | "acp";
      backgroundTask?: string;
      choices: Array<{
        label: string;
        value: string;
        isPrimary?: boolean;
        isDanger?: boolean;
      }>;
      writeChoices?: Array<{
        label: string;
        value: string;
        isPrimary?: boolean;
        isDanger?: boolean;
      }>;
      targetPath?: string;
      commandText?: string;
      commandReason?: string;
      humanOnlyReason?: string;
      cwd?: string;
    },
    sessionId?: string,
  ): ApprovalRequest {
    const session = sessionId
      ? this.sessionManager?.getSession(sessionId)
      : undefined;
    const sourceScope = session?.projectScope;
    const sourceProject = sourceScope
      ? {
          projectId: sourceScope.projectId,
          displayName: sourceScope.displayName,
          availability: session.projectAvailability,
        }
      : undefined;
    const targetPath = request.targetPath
      ? canonicalizePath(
          path.isAbsolute(request.targetPath)
            ? request.targetPath
            : sourceScope?.rootPath
              ? path.resolve(sourceScope.rootPath, request.targetPath)
              : request.targetPath,
        )
      : undefined;
    const target = targetPath
      ? this.getWorkspaceProjects()
          .filter((project) => project.rootPath)
          .sort(
            (left, right) =>
              (right.rootPath?.length ?? 0) - (left.rootPath?.length ?? 0),
          )
          .find((project) =>
            isPathWithinRoot(targetPath, canonicalizePath(project.rootPath!)),
          )
      : undefined;
    const targetProject =
      target && target.id !== sourceProject?.projectId
        ? {
            projectId: target.id,
            displayName: target.name,
            availability:
              target.availability.status === "available"
                ? ("available" as const)
                : ("unavailable" as const),
          }
        : undefined;
    const projectContext = {
      sourceProject,
      targetProject,
      targetPath,
      ...(request.backgroundTask
        ? { backgroundTask: request.backgroundTask }
        : {}),
    };
    switch (request.kind) {
      case "write": {
        const pathMatch = request.title.match(/`([^`]+)`/);
        const filePath = pathMatch?.[1] ?? request.title;
        const isCreate = request.title.startsWith("Create");
        return {
          kind: "write",
          id,
          ...projectContext,
          filePath,
          writeOperation: isCreate ? "create" : "modify",
          detail: request.detail,
          writeChoices: request.writeChoices,
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
          ...projectContext,
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
          ...projectContext,
          command: request.title,
          mcpDetail: request.detail,
          mcpServerName: request.mcpServerName,
          mcpToolName: request.mcpToolName,
          toolOrigin: request.toolOrigin,
          mcpChoices: request.choices,
        };
      case "mode-switch":
        return {
          kind: "mode-switch",
          id,
          ...projectContext,
          command: request.title,
          mcpDetail: request.detail,
        };
      case "memory":
        return {
          kind: "memory",
          id,
          ...projectContext,
          command: request.title,
          mcpDetail: request.detail,
        };
      case "hook":
        return {
          kind: "hook",
          id,
          ...projectContext,
          command: request.commandText ?? request.title,
          detail: request.detail,
          hookChoices: request.choices,
        };
      case "worktree":
        return {
          kind: "worktree",
          id,
          ...projectContext,
          command: request.title,
          detail: request.detail,
          worktreeChoices: request.choices,
        };
      default:
        return {
          kind: request.kind as ApprovalRequest["kind"],
          id,
          ...projectContext,
          command: request.commandText ?? request.detail ?? request.title,
          ...(request.commandReason ? { reason: request.commandReason } : {}),
          ...(request.humanOnlyReason
            ? { humanOnlyReason: request.humanOnlyReason }
            : {}),
          ...(request.cwd ? { cwd: request.cwd } : {}),
          subCommands: [],
        };
    }
  }

  /**
   * Ask the user a set of questions via the chat webview and wait for responses.
   * Called by the ask_user tool handler in toolAdapter.
   */
  public readonly handleToolQuestion: NonNullable<
    ToolDispatchContext["onQuestion"]
  > = (...args) => this.requestQuestion(...args);

  private restorePendingQuestionRecovery(
    session: AgentSession,
    question: PendingQuestionRecoveryState,
  ): void {
    this.showQuestionAttention(question.questionRequestId, session.id, true);
    if (session.id !== this.sessionManager?.getForegroundSession()?.id) return;
    this.ensureProjectedForegroundSession(session);
    this.applyProjectedAction({
      type: "SET_QUESTION",
      id: question.questionRequestId,
      toolCallId: question.toolUseId,
      context: question.context,
      questions: question.questions,
    });
    this.uiPublisher.publishQuestionRequest(
      session.id,
      question.questionRequestId,
      question.context,
      question.questions,
      undefined,
      question.toolUseId,
    );
  }

  public requestQuestion(
    context: string,
    questions: import("@agentlink/protocol/structured-question").UserQuestion[],
    sessionId: string,
    backgroundTask?: string,
    pendingQuestionRecovery?: import("../core/tools/types.js").PendingQuestionRecoveryContext,
    toolCallId?: string,
  ): Promise<import("./toolAdapter.js").QuestionResponse> {
    const { randomUUID } = require("crypto") as typeof import("crypto");
    const id = randomUUID();
    // Register in the session index so agentStop can cancel only this session's questions
    const sessionSet = this.questionSessionIndex.get(sessionId) ?? new Set();
    sessionSet.add(id);
    this.questionSessionIndex.set(sessionId, sessionSet);
    this.questionSessionById.set(id, sessionId);
    this.showQuestionAttention(id, sessionId);
    return new Promise((resolve) => {
      this.pendingQuestions.set(id, (raw) => {
        this.questionSessionIndex.get(sessionId)?.delete(id);
        this.questionSessionById.delete(id);
        this.clearQuestionAttention(id);
        this.sessionManager?.clearPendingQuestionRecovery(sessionId, id);
        resolve({
          answers:
            raw.answers as import("./toolAdapter.js").QuestionResponse["answers"],
          notes: (raw.notes as Record<string, string>) ?? {},
          attachments: raw.attachments,
        });
      });
      const foregroundSession = this.sessionManager?.getForegroundSession();
      if (foregroundSession?.id === sessionId) {
        this.ensureProjectedForegroundSession(foregroundSession);
        this.applyProjectedAction({
          type: "SET_QUESTION",
          id,
          context,
          questions,
          ...(toolCallId ? { toolCallId } : {}),
          ...(backgroundTask ? { backgroundTask } : {}),
        });
        if (!backgroundTask && pendingQuestionRecovery) {
          void this.sessionManager?.persistPendingQuestionRecovery(
            sessionId,
            id,
            context,
            questions,
            pendingQuestionRecovery,
          );
        }
      }
      this.uiPublisher.publishQuestionRequest(
        sessionId,
        id,
        context,
        questions,
        backgroundTask,
        toolCallId ?? pendingQuestionRecovery?.toolUseId,
      );
    });
  }

  private showQuestionAttention(
    id: string,
    sessionId: string,
    recovered = false,
  ): void {
    if (
      this.questionAttentionById.has(id) ||
      !this.showPendingInteractionAlert
    ) {
      return;
    }
    this.questionAttentionById.set(id, {
      attention: this.showPendingInteractionAlert(
        "Question requires a response",
        {
          command: "agentLink.focusApproval",
          title: "Focus pending AgentLink question",
          arguments: [{ sessionId }],
        },
      ),
      recovered,
      sessionId,
    });
  }

  private clearQuestionAttention(id: string): void {
    this.questionAttentionById.get(id)?.attention.dispose();
    this.questionAttentionById.delete(id);
  }

  private reconcileQuestionAttention(): void {
    const manager = this.sessionManager;
    if (!manager) return;
    for (const [id, pending] of this.questionAttentionById) {
      const session = manager.getSession(pending.sessionId);
      const recovery = pending.recovered
        ? manager.getPendingQuestionRecovery(pending.sessionId)
        : null;
      const remainsPending = pending.recovered
        ? recovery?.questionRequestId === id
        : Boolean(
            session && !session.isAborted && this.pendingQuestions.has(id),
          );
      if (remainsPending) continue;

      const resolve = this.pendingQuestions.get(id);
      this.pendingQuestions.delete(id);
      this.questionSessionById.delete(id);
      this.questionSessionIndex.get(pending.sessionId)?.delete(id);
      resolve?.({ answers: {}, notes: {} });
      this.uiPublisher.publishQuestionCleared(pending.sessionId, id);
      this.clearQuestionAttention(id);
    }
  }

  public submitBrowserApprovalDecision(msg: {
    id: string;
    approvalKind?: ApprovalRequest["kind"];
    decision?: string;
    editedCommand?: string;
    rejectionReason?: string;
    rulePattern?: string;
    ruleMode?: string;
    rules?: Array<{
      pattern: string;
      mode: string;
      decision?: "allow" | "prompt" | "forbidden";
      scope: string;
    }>;
    trustScope?: string;
    editedContent?: string;
    memoryTier?: import("@agentlink/protocol/inline-approval").MemoryTier;
    memoryScope?: import("@agentlink/protocol/inline-approval").MemoryScope;
    memoryName?: string;
    followUp?: string;
  }): boolean {
    const id = msg.id;
    const activeRequest = this.activeApprovalRequests.get(id);
    const resolveInline = this.pendingApprovals.get(id);
    if (resolveInline) {
      if (!activeRequest || msg.approvalKind !== activeRequest.kind)
        return false;
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

    const pending = this.pendingForwardedApprovals.get(id);
    if (!pending || msg.approvalKind !== pending.kind) return false;
    const decision: DecisionMessage = {
      type: "decision",
      id,
      approvalKind: msg.approvalKind,
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
    const accepted = pending.respond(decision);
    if (!accepted) return false;
    this.pendingForwardedApprovals.delete(id);
    this.clearApprovalRequest(pending.sessionId, id);
    return true;
  }

  public async submitBrowserQuestionResponse(msg: {
    id: string;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes?: Record<string, string>;
    attachments?: import("@agentlink/protocol/structured-question").UserQuestionResponse["attachments"];
    sessionId?: string;
  }): Promise<boolean> {
    const normalizedAttachments = normalizeUserQuestionAttachments(
      msg.attachments,
    );
    const attachments =
      Object.keys(normalizedAttachments).length > 0
        ? normalizedAttachments
        : undefined;
    const resolve = this.pendingQuestions.get(msg.id);
    if (!resolve) {
      const recoverySession = msg.sessionId
        ? this.sessionManager?.getSession(msg.sessionId)
        : this.sessionManager?.getForegroundSession();
      const pendingQuestion = recoverySession
        ? this.sessionManager?.getPendingQuestionRecovery(recoverySession.id)
        : null;
      if (recoverySession && pendingQuestion?.questionRequestId === msg.id) {
        const accepted =
          (await this.sessionManager?.answerRecoveredQuestion(
            recoverySession.id,
            msg.id,
            {
              answers: msg.answers,
              notes: msg.notes ?? {},
              attachments,
            },
            {
              switchMode: (request) =>
                this.handleModeSwitch(
                  request.mode,
                  request.reason,
                  request.silent,
                  recoverySession.id,
                ),
            },
          )) === true;
        if (!accepted) {
          this.clearQuestionAttention(msg.id);
          return false;
        }
        this.clearQuestionAttention(msg.id);
        if (
          this.sessionManager?.getForegroundSession()?.id === recoverySession.id
        ) {
          this.applyProjectedAction({ type: "CLEAR_QUESTION", id: msg.id });
        }
        this.uiPublisher.publishQuestionCleared(recoverySession.id, msg.id);
        // The recovered answer was committed straight into session history
        // (assistant ask_user tool_use + tool_result) without flowing through
        // live agent events, so neither surface has the turn in its
        // transcript. Resync both from session history.
        if (
          this.sessionManager?.getForegroundSession()?.id === recoverySession.id
        ) {
          this.postSessionLoaded(recoverySession);
        } else {
          this.postMessage(this.buildSessionLoadedMessage(recoverySession));
        }
        return true;
      }
      return false;
    }
    const sessionId = this.questionSessionById.get(msg.id);
    if (!sessionId) return false;
    this.pendingQuestions.delete(msg.id);
    this.questionSessionById.delete(msg.id);
    this.clearQuestionAttention(msg.id);
    resolve({
      answers: msg.answers,
      notes: msg.notes ?? {},
      attachments,
    });
    this.applyProjectedAction({
      type: "SUBMIT_QUESTION",
      id: msg.id,
      answers: msg.answers,
      notes: msg.notes ?? {},
    });
    this.uiPublisher.publishQuestionCleared(sessionId, msg.id);
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
    const sessionId = this.questionSessionById.get(progress.id);
    if (!sessionId) return false;
    this.uiPublisher.publishQuestionProgress(sessionId, progress);
    return true;
  }

  public submitBrowserFormElicitation(
    response: McpFormElicitationResponse,
  ): McpFormElicitationSubmitResult {
    return this.formElicitationCoordinator.submit(response);
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
    pending.resolve(action);
    this.uiPublisher.publishUrlElicitationCleared(pending.sessionId, id);
    return true;
  }

  private cancelPendingUrlElicitations(): void {
    for (const [id, pending] of this.pendingUrlElicitations) {
      pending.resolve("cancel");
      this.uiPublisher.publishUrlElicitationCleared(pending.sessionId, id);
    }
    this.pendingUrlElicitations.clear();
  }

  public runContextDoctor(sessionId?: string): {
    ok: boolean;
    error?: string;
  } {
    const manager = this.sessionManager;
    const foreground = manager?.getForegroundSession();
    if (!manager || !foreground)
      return { ok: false, error: "no_active_session" };
    if (sessionId !== undefined && sessionId !== foreground.id) {
      return { ok: false, error: "session_not_foreground" };
    }
    if (isProjectlessSessionScope(foreground.projectScope)) {
      return { ok: false, error: "workspace_session_required" };
    }
    if (
      foreground.status === "queued" ||
      foreground.status === "streaming" ||
      foreground.status === "tool_executing" ||
      foreground.status === "awaiting_approval"
    ) {
      return { ok: false, error: "session_busy" };
    }

    const report = buildContextDoctorReport({
      model: foreground.model,
      mode: foreground.mode,
      lastInputTokens: foreground.lastInputTokens,
      lastOutputTokens: foreground.lastOutputTokens,
      lastCacheReadTokens: foreground.lastCacheReadTokens,
      contextBreakdown: foreground.contextBreakdown,
      toolResultContextAttributions: foreground.toolResultContextAttributions,
      omittedToolResultContextAttributions:
        foreground.omittedToolResultContextAttributions,
      messages: foreground.getAllMessages(),
    });
    foreground.appendAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: report.markdown }],
      diagnosticOnly: true,
    });
    manager.saveSession(foreground.id);
    this.postSessionLoaded(foreground, {
      checkpoints: this.getSessionCheckpoints(foreground.id),
      tailTurns: 0,
    });
    return { ok: true };
  }

  public async prepareBrowserSessionHandoff(
    sessionId?: string,
  ): Promise<
    | { ok: true; draft: import("./sessionHandoff.js").SessionHandoffDraft }
    | { ok: false; error: string }
  > {
    const selected =
      sessionId ?? this.sessionManager?.getForegroundSession()?.id;
    const result = await this.sessionManager?.prepareSessionHandoff(selected);
    return result?.ok
      ? result
      : { ok: false, error: result?.message ?? "No active session is loaded." };
  }

  public async confirmBrowserSessionHandoff(
    draftId: string,
    markdown: string,
  ): Promise<{ ok: boolean; successorSessionId?: string; error?: string }> {
    const result = await this.sessionManager?.confirmSessionHandoff(
      draftId,
      markdown,
    );
    return result?.ok
      ? result
      : {
          ok: false,
          error: result?.message ?? "The fresh session could not be started.",
        };
  }

  public cancelBrowserSessionHandoff(draftId: string): void {
    this.sessionManager?.cancelSessionHandoff(draftId);
  }

  public async submitBrowserSend(input: {
    text: string;
    id?: string;
    mode?: string;
    sessionId?: string;
    projectId?: string;
    thinkingEnabled?: boolean;
    reasoningEffort?: import("./providers/types.js").ReasoningEffort;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
    displayText?: string;
    slashCommandLabel?: string;
    isSlashCommand?: boolean;
    interject?: boolean;
    model?: string;
  }): Promise<{
    ok: boolean;
    queued?: boolean;
    interjected?: boolean;
    error?: string;
  }> {
    const text = input.text;
    const mode = this.hasWorkspaceProjects() ? (input.mode ?? "code") : "ask";
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
    const isContextDoctorCommand =
      text?.trim() === "/context-doctor" &&
      attachments.length === 0 &&
      images.length === 0 &&
      documents.length === 0;

    if (
      !text?.trim() &&
      attachments.length === 0 &&
      images.length === 0 &&
      documents.length === 0
    ) {
      return { ok: false };
    }

    const mgr = this.sessionManager;
    if (!mgr) return { ok: false };
    let effectiveSessionId =
      await this.resolveForegroundSessionTransition(sessionId);

    if (isContextDoctorCommand) {
      const effectiveSession = effectiveSessionId
        ? mgr.getSession(effectiveSessionId)
        : undefined;
      if (!effectiveSession) return { ok: false, error: "no_active_session" };
      if (
        input.projectId !== undefined &&
        effectiveSession.projectScope.projectId !== input.projectId
      ) {
        return { ok: false, error: "project_state_mismatch" };
      }
      return this.runContextDoctor(effectiveSessionId);
    }

    if (!effectiveSessionId || !mgr.getSession(effectiveSessionId)) {
      const newSession = await mgr.createSession(mode, {
        activeFilePath: vscode.window.activeTextEditor?.document.uri.fsPath,
        projectId: input.projectId,
      });
      effectiveSessionId = newSession.id;
      this.approvalManager?.migrateSessionState("agent", effectiveSessionId);
    }

    const effectiveSession = mgr.getSession(effectiveSessionId);
    if (
      !effectiveSession ||
      (input.projectId !== undefined &&
        effectiveSession.projectScope.projectId !== input.projectId)
    ) {
      return { ok: false, error: "project_state_mismatch" };
    }
    const requestedModel = input.model ?? effectiveSession.model;
    const selectedModel = (await this.getBrowserModels()).find(
      (model) => model.id === requestedModel,
    );
    if (input.model && !selectedModel?.authenticated) {
      return {
        ok: false,
        error: selectedModel
          ? `Set up ${selectedModel.providerDisplayName ?? selectedModel.provider} before sending a message.`
          : "Choose an available model before sending a message.",
      };
    }
    if (!input.model && selectedModel && !selectedModel.authenticated) {
      return {
        ok: false,
        error: `Set up ${selectedModel.providerDisplayName ?? selectedModel.provider} before sending a message.`,
      };
    }
    const projectless = isProjectlessSessionScope(
      effectiveSession.projectScope,
    );
    if (projectless && attachments.length > 0) {
      return {
        ok: false,
        error: "Open a folder before attaching local workspace files.",
      };
    }
    const projectRoot = this.getSessionProjectRoot(effectiveSessionId);
    if (!projectless && !projectRoot) {
      return { ok: false, error: "project_unavailable" };
    }
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

      // Preserve a browser-supplied message identity through the queue so the
      // remote commit replaces the browser's optimistic transcript row.
      const queueId = input.id ?? randomUUID();
      const displayQueueText = displayText ?? text;
      const displayMedia = mediaToDisplayMedia({ images, documents });

      this.postMessage({
        type: "agentQueuedMessage",
        sessionId: effectiveSessionId,
        queueId,
        text,
        displayText: displayQueueText,
        isSlashCommand,
        slashCommandLabel,
        attachments: attachments.length > 0 ? attachments : undefined,
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
        displayMedia,
        source: "browser",
      });
      const interjected = input.interject
        ? this.interjectQueuedMessageFromUi({
            sessionId: effectiveSessionId,
            queueId,
            text,
            displayText: displayQueueText,
            isSlashCommand,
            slashCommandLabel,
            attachments,
            images,
            documents,
          })
        : undefined;
      return {
        ok: true,
        queued: true,
        ...(interjected !== undefined ? { interjected } : {}),
      };
    }

    const resolved = projectless
      ? { text, images: [], documents: [] }
      : await this.resolveAttachments(text, attachments, projectRoot!);
    const resolvedImages = [...images, ...resolved.images];
    const resolvedDocuments = [...documents, ...resolved.documents];

    this.postMessage({
      type: "agentCommittedUserMessage",
      sessionId: effectiveSessionId,
      id: input.id,
      text: resolved.text,
      displayText: displayText ?? text,
      isSlashCommand,
      slashCommandLabel,
      origin: "browser",
      displayMedia: mediaToDisplayMedia({
        images: resolvedImages,
        documents: resolvedDocuments,
      }),
    });

    mgr
      .sendMessage(effectiveSessionId, resolved.text, mode, {
        thinkingEnabled,
        reasoningEffort,
        activeFilePath: effectiveSession?.activeFilePath,
        displayText: displayText ?? text,
        isSlashCommand,
        slashCommandLabel,
        origin: "browser",
        images: resolvedImages.length > 0 ? resolvedImages : undefined,
        documents: resolvedDocuments.length > 0 ? resolvedDocuments : undefined,
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
          ...this.getBrowserSessionApprovalMode(),
          configuredCommandApprovalPolicy:
            this.getConfiguredCommandApprovalPolicy(),
        },
      });
    }

    return { ok: true };
  }

  public async submitBrowserModeSwitch(
    mode: string,
    projectId?: string,
    sessionId?: string,
  ): Promise<{
    approved: boolean;
    mode: string;
  }> {
    const session = sessionId
      ? this.sessionManager?.getSession(sessionId)
      : this.sessionManager?.getForegroundSession();
    if (
      !session ||
      !projectId ||
      session.projectScope.projectId !== projectId ||
      !this.getAvailableBrowserProjectScope(projectId)
    ) {
      return { approved: false, mode };
    }
    if (session.mode !== mode) {
      try {
        const previousMode = session.mode;
        const switched = await this.withAsyncApprovalStateTransition(
          async () => {
            const updated = sessionId
              ? await this.sessionManager?.switchSessionMode(session.id, mode, {
                  initialArchitectReviewApproved: true,
                })
              : await this.sessionManager?.switchForegroundMode(mode, {
                  initialArchitectReviewApproved: true,
                });
            if (!updated) return null;
            if (previousMode !== updated.mode) {
              this.recordSurfaceChange(updated, {
                mode: { previousMode, mode: updated.mode },
              });
            }
            this.reconcileSessionApprovalAfterModeSwitch(updated.id);
            if (
              this.sessionManager?.getForegroundSession()?.id === updated.id
            ) {
              this.sendInitialState();
            } else {
              this.postMessage({
                type: "stateUpdate",
                state: this.buildChatState(updated),
              });
            }
            return updated;
          },
        );
        if (!switched) return { approved: false, mode };
        this.log(`[mode] browser switched session ${session.id} to ${mode}`);
        return { approved: true, mode };
      } catch (err) {
        this.log(`[mode] browser failed to switch mode: ${err}`);
        return { approved: false, mode };
      }
    }

    return { approved: true, mode };
  }

  private getPreferenceConfigurationTarget(
    projectScope = this.getCurrentProjectScope(),
  ): {
    config: vscode.WorkspaceConfiguration;
    target: vscode.ConfigurationTarget;
    scopeLabel: "workspace folder" | "user";
  } {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaceFolder =
      workspaceFolders.find(
        (folder) =>
          folder.uri.toString() === projectScope?.workspaceFolderUri ||
          folder.uri.fsPath === projectScope?.rootPath,
      ) ?? workspaceFolders[0];
    return {
      config: vscode.workspace.getConfiguration(
        "agentlink",
        workspaceFolder?.uri,
      ),
      target: workspaceFolder
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Global,
      scopeLabel: workspaceFolder ? "workspace folder" : "user",
    };
  }

  public async submitBrowserSetModel(
    model: string,
    sessionId?: string,
  ): Promise<{ ok: boolean }> {
    if (sessionId) return this.submitSessionSetModel(sessionId, model);
    if (!model || !this.sessionManager) return { ok: false };
    const foregroundBefore = this.sessionManager.getForegroundSession();
    const previousModel = foregroundBefore?.model;
    const selectedModel = await this.sessionManager.setModel(model);
    const foreground = this.sessionManager.getForegroundSession();
    if (foreground && previousModel && previousModel !== selectedModel) {
      this.recordSurfaceChange(foreground, {
        model: { previousModel, model: selectedModel },
      });
    }
    const foregroundMode =
      foreground?.mode ?? (this.hasWorkspaceProjects() ? "code" : "ask");
    const { config, target, scopeLabel } =
      this.getPreferenceConfigurationTarget(foreground?.projectScope);
    const modePreferences = getModeModelPreferences(config);
    await config.update(
      "modeModelPreferences",
      {
        ...modePreferences,
        [foregroundMode]: selectedModel,
      },
      target,
    );

    this.sendInitialState();
    this.log(
      `Model changed to: ${selectedModel} (saved for mode: ${foregroundMode}, scope: ${scopeLabel})`,
    );
    return { ok: true };
  }

  private async submitSessionSetModel(
    sessionId: string,
    model: string,
  ): Promise<{ ok: boolean }> {
    const session = this.sessionManager?.getSession(sessionId);
    if (!model || !session || !this.sessionManager) return { ok: false };
    const previousModel = session.model;
    const selectedModel = await this.sessionManager.setSessionModel(
      sessionId,
      model,
    );
    if (previousModel !== selectedModel) {
      this.recordSurfaceChange(session, {
        model: { previousModel, model: selectedModel },
      });
    }
    const { config, target, scopeLabel } =
      this.getPreferenceConfigurationTarget(session.projectScope);
    const modePrefs = getModeModelPreferences(config);
    await config.update(
      "modeModelPreferences",
      {
        ...modePrefs,
        [session.mode]: selectedModel,
      },
      target,
    );

    this.postMessage({
      type: "stateUpdate",
      state: this.buildChatState(session),
    });
    this.log(
      `Model changed to: ${selectedModel} (saved for mode: ${session.mode}, scope: ${scopeLabel})`,
    );
    return { ok: true };
  }

  public submitBrowserSetCommandApprovalPolicy(
    policy: unknown,
    requestedSessionId?: string,
  ): {
    ok: boolean;
  } {
    if (!isCommandApprovalPolicy(policy) || !this.sessionManager) {
      return { ok: false };
    }

    const foreground = this.sessionManager.getForegroundSession();
    const session = requestedSessionId
      ? this.sessionManager.getSession(requestedSessionId)
      : foreground;
    if (requestedSessionId && !session) return { ok: false };
    const sessionId = session?.id ?? "agent";
    const result = this.setSessionCommandApprovalPolicy(
      sessionId,
      policy,
      session?.projectScope.rootPath,
    );
    this.log(
      result?.ok
        ? `Command approval policy changed to: ${policy}`
        : `Command approval policy change failed for: ${policy}`,
    );
    return { ok: result?.ok ?? false };
  }

  public submitBrowserSetWriteApproval(
    mode: string,
    requestedSessionId?: string,
  ): { ok: boolean } {
    if (
      !this.approvalManager ||
      (mode !== "prompt" &&
        mode !== "session" &&
        mode !== "project" &&
        mode !== "global")
    ) {
      return { ok: false };
    }

    const fgSession = this.sessionManager?.getForegroundSession();
    const session = requestedSessionId
      ? this.sessionManager?.getSession(requestedSessionId)
      : fgSession;
    if (requestedSessionId && !session) return { ok: false };
    const sessionId = session?.id ?? "agent";
    const result = this.setSessionWriteApproval(
      sessionId,
      mode,
      session?.projectScope.rootPath,
    );

    this.log(
      result?.ok
        ? `Agent write approval changed to: ${mode}`
        : `Agent write approval change failed for: ${mode}`,
    );
    return { ok: result?.ok ?? false };
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

  public async submitBrowserSetThinkingEnabled(
    enabled: boolean,
    sessionId?: string,
  ): Promise<{ ok: boolean }> {
    return this.submitBrowserSetReasoningEffort(
      enabled ? "high" : "none",
      sessionId,
    );
  }

  public async submitBrowserSetReasoningEffort(
    effort: import("./providers/types.js").ReasoningEffort,
    sessionId?: string,
  ): Promise<{ ok: boolean }> {
    if (sessionId)
      return this.submitSessionSetReasoningEffort(sessionId, effort);
    const foreground = this.sessionManager?.getForegroundSession();
    if (!foreground || !this.sessionManager) return { ok: false };
    const previousReasoningEffort = foreground.reasoningEffort;
    this.ensureProjectedForegroundSession(foreground);
    const updated =
      this.sessionManager.setSessionReasoningEffort?.(foreground.id, effort) ??
      this.sessionManager.setForegroundReasoningEffort?.(effort) ??
      false;
    if (!updated) return { ok: false };
    const { config, target } = this.getPreferenceConfigurationTarget(
      foreground.projectScope,
    );
    const preferences = getModeReasoningEffortPreferences(config);
    await config.update(
      "modeReasoningEffortPreferences",
      { ...preferences, [foreground.mode]: effort },
      target,
    );
    if (previousReasoningEffort !== effort) {
      this.recordSurfaceChange(foreground, {
        reasoning: { previousReasoningEffort, reasoningEffort: effort },
      });
    }
    this.applyProjectedAction({ type: "SET_REASONING_EFFORT", effort });
    this.sendInitialState();
    this.log(
      `Reasoning effort changed: ${effort} (saved for mode: ${foreground.mode})`,
    );
    return { ok: true };
  }

  private async submitSessionSetReasoningEffort(
    sessionId: string,
    effort: import("./providers/types.js").ReasoningEffort,
  ): Promise<{ ok: boolean }> {
    const session = this.sessionManager?.getSession(sessionId);
    if (!session || !this.sessionManager) return { ok: false };
    const previousReasoningEffort = session.reasoningEffort;
    if (!this.sessionManager.setSessionReasoningEffort(sessionId, effort)) {
      return { ok: false };
    }
    const { config, target } = this.getPreferenceConfigurationTarget(
      session.projectScope,
    );
    const preferences = getModeReasoningEffortPreferences(config);
    await config.update(
      "modeReasoningEffortPreferences",
      { ...preferences, [session.mode]: effort },
      target,
    );
    if (previousReasoningEffort !== effort) {
      this.recordSurfaceChange(session, {
        reasoning: { previousReasoningEffort, reasoningEffort: effort },
      });
    }
    if (this.sessionManager.getForegroundSession()?.id === sessionId) {
      this.ensureProjectedForegroundSession(session);
      this.applyProjectedAction({ type: "SET_REASONING_EFFORT", effort });
    }
    this.postMessage({
      type: "stateUpdate",
      state: this.buildChatState(session),
    });
    this.log(
      `Reasoning effort changed: ${effort} (saved for mode: ${session.mode})`,
    );
    return { ok: true };
  }

  private recordSurfaceChange(
    session: AgentSession,
    change: NonNullable<ChatMessage["surfaceChange"]>,
  ): void {
    if (session.getAllMessages().every((message) => message.diagnosticOnly))
      return;
    session.appendSurfaceChange(change);
    this.sessionManager?.saveSession(session.id);
    if (this.sessionManager?.getForegroundSession()?.id === session.id) {
      this.postMessage({
        type: "agentSurfaceChange",
        sessionId: session.id,
        change,
      });
    }
  }

  public async submitBrowserNewSession(
    mode?: string,
    projectId?: string,
    address?: ChatTabActionAddress,
    stopRunning = false,
  ): Promise<{
    ok: boolean;
    sessionId?: string;
    projectId?: string;
    tabId?: string;
    controllerEpoch?: string;
    reason?: string;
  }> {
    if (!this.sessionManager) return { ok: false };
    const nextMode = mode?.trim() || "code";
    if (address) {
      const result = await this.chatTabHostCoordinator?.newChat(
        address,
        nextMode,
        { projectId, focus: false, stopRunning },
      );
      if (!result) return { ok: false, reason: "tab_host_unavailable" };
      if (!result.ok) return { ok: false, reason: result.reason };
      if (!result.session) return { ok: false, reason: "session_not_found" };
      this.log(
        `New session created from browser for tab ${address.tabId} (${nextMode}, model: ${result.session.model})`,
      );
      return {
        ok: true,
        sessionId: result.session.id,
        projectId: result.session.projectScope.projectId,
        tabId: result.tab.id,
        controllerEpoch: address.controllerEpoch,
      };
    }
    const transition = this.beginForegroundSessionTransition(nextMode, {
      projectId,
    });
    const session = await transition.promise;
    this.postSessionLoaded(session, {
      checkpoints: this.getSessionCheckpoints(session.id),
      tailTurns: 0,
    });
    this.sendInitialState();
    this.log(
      `New session created from browser (${nextMode}, model: ${session.model})`,
    );
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectScope.projectId,
    };
  }

  private beginForegroundSessionTransition(
    mode: string,
    opts?: { projectId?: string },
  ): NonNullable<ChatViewProvider["foregroundSessionTransition"]> {
    if (!this.sessionManager) {
      throw new Error("Session manager is not initialized.");
    }
    const transition: NonNullable<
      ChatViewProvider["foregroundSessionTransition"]
    > = {
      previousSessionId: this.sessionManager.getForegroundSession()?.id,
      promise: this.sessionManager.createForegroundSession(mode, opts),
    };
    this.foregroundSessionTransition = transition;
    void transition.promise
      .then((session) => {
        transition.nextSessionId = session.id;
      })
      .catch(() => {
        if (this.foregroundSessionTransition === transition) {
          this.foregroundSessionTransition = undefined;
        }
      });
    return transition;
  }

  private async resolveForegroundSessionTransition(
    requestedSessionId: string | null | undefined,
  ): Promise<string | undefined> {
    const transition = this.foregroundSessionTransition;
    if (!transition) return requestedSessionId ?? undefined;

    if (
      requestedSessionId != null &&
      requestedSessionId !== transition.previousSessionId
    ) {
      if (
        requestedSessionId === transition.nextSessionId &&
        this.foregroundSessionTransition === transition
      ) {
        this.foregroundSessionTransition = undefined;
      }
      return requestedSessionId;
    }

    return (await transition.promise).id;
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
    address?: ChatTabActionAddress,
    stopRunning = false,
  ): Promise<{
    ok: boolean;
    reason?: string;
    sessionId?: string;
    tabId?: string;
    controllerEpoch?: string;
  }> {
    if (!sessionId || !this.sessionManager) return { ok: false };
    if (address) {
      const result = await this.chatTabHostCoordinator?.loadSession(
        address,
        sessionId,
        { focus: false, stopRunning },
      );
      if (!result) return { ok: false, reason: "tab_host_unavailable" };
      if (!result.ok) return { ok: false, reason: result.reason };
      return {
        ok: true,
        sessionId: result.tab.sessionId ?? undefined,
        tabId: result.tab.id,
        controllerEpoch: address.controllerEpoch,
      };
    }
    const session = await this.sessionManager.loadPersistedSession(sessionId);
    if (!session) {
      this.log(`[history] session not found: ${sessionId}`);
      return { ok: false };
    }
    this.foregroundSessionTransition = undefined;
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

    const fg = this.sessionManager?.getForegroundSession();
    const debugRoot = fg?.projectScope
      ? fg.projectScope.rootPath
      : fg
        ? undefined
        : this.cwd;
    const activeFilePath = fg
      ? fg.activeFileContext?.status === "accepted"
        ? fg.activeFileContext.activeFilePath
        : undefined
      : vscode.window.activeTextEditor?.document.uri.fsPath;
    if (fg?.projectScope) {
      info["project.id"] = fg.projectScope.projectId;
      info["project.availability"] = fg.projectAvailability;
      if (fg.activeFileContext) {
        info["project.activeFileContext"] =
          fg.activeFileContext.status === "accepted"
            ? "accepted"
            : `ignored:${fg.activeFileContext.reason}`;
      }
    }
    let systemPrompt = fg?.systemPrompt;
    if (!systemPrompt && debugRoot) {
      try {
        const mode = fg?.mode ?? "code";
        const model = fg?.model ?? this.sessionManager?.getConfig().model;
        const providerId = model
          ? providerRegistry.tryResolveProvider(model)?.id
          : undefined;
        systemPrompt = await buildSystemPrompt(mode, debugRoot, {
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
    if (debugRoot) {
      try {
        const blocks = await loadAllInstructionBlocks(debugRoot, {
          activeFilePath,
        });
        loadedInstructions = blocks.map((block) =>
          formatInstructionDebugInfo(block, debugRoot, activeFilePath),
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

  public async submitBrowserAskAgentMcpTool(input: {
    name?: string;
    input?: Record<string, unknown>;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    result?: ToolResult;
    tools?: ReturnType<typeof getAgentTools>;
    error?: string;
  }> {
    const toolName = input.name?.trim();
    if (!toolName) return { ok: false, error: "invalid_request" };
    const sessionId =
      input.sessionId?.trim() || "browser-gateway:ask-agent:mcp";
    const mcpToolDefs = this.askAgentMcpHub.getToolDefs();
    const codeMode = BUILT_IN_MODES[0];
    const tools = getAgentTools(codeMode, mcpToolDefs).filter(
      (tool) =>
        McpClientHub.isMcpTool(tool.name) ||
        MCP_TOOL_BRIDGE_TOOL_NAMES.includes(tool.name),
    );
    if (!tools.some((tool) => tool.name === toolName)) {
      return { ok: false, error: "tool_not_available", tools };
    }
    if (!this.approvalManager) {
      return { ok: false, error: "approval_manager_unavailable", tools };
    }
    const result = await dispatchToolCall(toolName, input.input ?? {}, {
      approvalManager: this.approvalManager,
      approvalPanel: undefined as never,
      sessionId,
      extensionUri: this.extensionUri,
      mcpHub: this.askAgentMcpHub,
      mcpPolicyMutationProvider: this.mcpPolicyMutationProvider,
      mode: "code",
      onApprovalRequest: (request, requestSessionId) =>
        this.requestApproval(request, requestSessionId),
      toolAbortSignal: input.signal,
      toolCallTracker: this.toolCallTracker,
    });
    return { ok: true, result, tools };
  }

  public async submitBrowserAskAgentMcpStatus(): Promise<{
    ok: boolean;
    infos: McpServerInfo[];
    configSnapshot: McpConfigSnapshot;
  }> {
    const infos = this.askAgentMcpHub.getServerInfos();
    return {
      ok: true,
      infos,
      configSnapshot: await this.buildMcpConfigSnapshot("ask-agent", infos),
    };
  }

  public async submitBrowserAskAgentMcpRefresh(): Promise<{
    ok: boolean;
    infos: McpServerInfo[];
    configSnapshot?: McpConfigSnapshot;
    error?: string;
  }> {
    try {
      await this.refreshAskAgentMcpConnections({
        interactiveForNewServers: false,
      });
      const infos = this.askAgentMcpHub.getServerInfos();
      return {
        ok: true,
        infos,
        configSnapshot: await this.buildMcpConfigSnapshot("ask-agent", infos),
      };
    } catch (err) {
      return {
        ok: false,
        infos: this.askAgentMcpHub.getServerInfos(),
        error: String(err),
      };
    }
  }

  public submitBrowserAskAgentWebPolicy(): {
    ok: true;
    settings: CoreWebAccessSettings;
    revision: string;
  } {
    const config = vscode.workspace.getConfiguration("agentlink");
    const settings = normalizeCoreWebAccessSettings({
      searchBackend: config.get("webAccess.searchBackend"),
      fetchBackend: config.get("webAccess.fetchBackend"),
      nativeSearchMode: config.get("webAccess.nativeSearchMode"),
      allowedDomains: config.get("webAccess.allowedDomains"),
      blockedDomains: config.get("webAccess.blockedDomains"),
      maxSearchUsesPerTurn: config.get("webAccess.maxSearchUsesPerTurn"),
      maxFetchUsesPerTurn: config.get("webAccess.maxFetchUsesPerTurn"),
      maxFetchContentTokens: config.get("webAccess.maxFetchContentTokens"),
      maxReplayBytesPerTurn: config.get("webAccess.maxReplayBytesPerTurn"),
    } as Partial<CoreWebAccessSettings>);
    return {
      ok: true,
      settings,
      revision: JSON.stringify(settings),
    };
  }

  public submitBrowserAskAgentMcpTools(): {
    ok: boolean;
    tools: ReturnType<typeof getAgentTools>;
    parallelSafeToolNames: string[];
    parallelSafeServerNames: string[];
  } {
    const parallelSafeServerNames =
      this.askAgentMcpHub.getParallelToolCallServerNames();
    const parallelSafeServers = new Set(parallelSafeServerNames);
    const tools = getAgentTools(
      BUILT_IN_MODES[0],
      this.askAgentMcpHub.getToolDefs(),
    ).filter(
      (tool) =>
        McpClientHub.isMcpTool(tool.name) ||
        MCP_TOOL_BRIDGE_TOOL_NAMES.includes(tool.name),
    );
    return {
      ok: true,
      tools,
      parallelSafeToolNames: tools
        .filter((tool) => {
          const separatorIndex = tool.name.indexOf("__");
          return (
            separatorIndex > 0 &&
            parallelSafeServers.has(tool.name.slice(0, separatorIndex))
          );
        })
        .map((tool) => tool.name),
      parallelSafeServerNames,
    };
  }

  private async persistMcpServerDisabled(
    profile: McpManagerProfile,
    serverName: string,
    projectScope = profile === "main"
      ? this.getCurrentProjectScope()
      : undefined,
  ): Promise<McpConfigMutationResult> {
    const snapshot = await this.buildMcpConfigSnapshot(
      profile,
      undefined,
      projectScope,
      this.getCurrentProjectMcpHub(projectScope),
    );
    const entry = snapshot.entries.find(
      (candidate) => candidate.name === serverName,
    );
    const scope =
      entry?.preferredEditScope ?? entry?.writableOverrideScopes?.at(-1);
    const expectedRevision = entry?.mutationRevision ?? snapshot.revision;
    if (!entry || !scope || !expectedRevision) {
      return {
        operationId: randomUUID(),
        ok: false,
        configSaved: false,
        errors: [{ code: "scope_not_writable", message: "scope_not_writable" }],
      };
    }
    return this.submitMcpConfigMutation(
      {
        operationId: randomUUID(),
        profile,
        scope,
        ...(entry.mutationTarget ? { target: entry.mutationTarget } : {}),
        ...(projectScope ? { projectId: projectScope.projectId } : {}),
        expectedRevision,
        operations: [
          {
            kind: "upsert",
            conflictAction: "replace",
            server: { ...entry.config, disabled: true },
          },
        ],
      },
      { allowMainProfileMutation: true },
    );
  }

  public async submitBrowserMcpAction(
    serverName: string,
    action: "disable" | "reconnect" | "reauthenticate",
    projectId?: string,
  ): Promise<{
    ok: boolean;
    infos?: ReturnType<McpClientHub["getServerInfos"]>;
    configSnapshot?: McpConfigSnapshot;
    errors?: McpConfigMutationResult["errors"];
  }> {
    if (!serverName || !action) return { ok: false };
    const projectScope = this.resolveMcpProjectScope(projectId);
    if (!projectScope?.rootPath) return { ok: false };
    const hub = this.getCurrentProjectMcpHub(projectScope) ?? this.mcpHub;
    const runtimeServerName = this.resolveProjectMcpRuntimeServerName(
      hub,
      projectScope.projectId,
      serverName,
    );
    if (!runtimeServerName) return { ok: false };
    if (action === "disable") {
      const result = await this.persistMcpServerDisabled(
        "main",
        serverName,
        projectScope,
      );
      return {
        ok: result.ok,
        configSnapshot: result.configSnapshot,
        errors: result.errors,
        infos: hub.getServerInfos(),
      };
    }
    if (action === "reconnect") {
      await hub.reconnectServer(runtimeServerName);
    } else {
      await hub.reauthenticateServer(runtimeServerName);
    }
    const configSnapshot = await this.buildMcpConfigSnapshot(
      "main",
      undefined,
      projectScope,
      hub,
    );
    await this.postMcpManagerSnapshot({
      profile: "main",
      projectScope,
      mainHub: hub,
    });
    return { ok: true, infos: hub.getServerInfos(), configSnapshot };
  }

  public async submitBrowserMcpConfigSnapshot(
    profile: McpManagerProfile,
    projectId?: string,
  ): Promise<{ ok: true; configSnapshot: McpConfigSnapshot }> {
    const projectScope =
      profile === "main" ? this.resolveMcpProjectScope(projectId) : undefined;
    const mainHub = this.getCurrentProjectMcpHub(projectScope);
    return {
      ok: true,
      configSnapshot: await this.buildMcpConfigSnapshot(
        profile,
        undefined,
        projectScope,
        mainHub,
      ),
    };
  }

  private buildMcpConnectionOutcomes(
    mutation: McpConfigBatchMutation,
    snapshot: McpConfigSnapshot,
  ): McpServerConnectionOutcome[] {
    const statuses = new Map(
      snapshot.statusInfos.map((info) => [info.name, info] as const),
    );
    return mutation.operations
      .filter((operation) => operation.kind === "upsert")
      .map((operation) => {
        const serverName =
          operation.conflictAction === "rename" && operation.renameTo
            ? operation.renameTo
            : operation.server.name;
        const status = statuses.get(serverName);
        if (!status) {
          return { serverName, status: "not_connected" as const };
        }
        if (status.status === "connected" || status.status === "connecting") {
          return { serverName, status: status.status };
        }
        if (status.status === "disabled") {
          return { serverName, status: "disabled" as const };
        }
        const authenticationRequired =
          status.error?.toLowerCase().includes("authentication") ?? false;
        return {
          serverName,
          status: authenticationRequired
            ? ("authentication_required" as const)
            : ("failed" as const),
          ...(status.error ? { error: status.error } : {}),
        };
      });
  }

  public async submitMcpConfigMutation(
    mutation: McpConfigBatchMutation,
    options: { allowMainProfileMutation?: boolean } = {},
  ): Promise<McpConfigMutationResult> {
    if (mutation.profile !== "ask-agent" && !options.allowMainProfileMutation) {
      return {
        operationId: mutation.operationId,
        ok: false,
        configSaved: false,
        errors: [
          {
            code: "scope_not_writable",
            message: "main_profile_read_only_in_browser",
          },
        ],
      };
    }
    const projectScope =
      mutation.profile === "main"
        ? this.resolveMcpProjectScope(mutation.projectId)
        : undefined;
    const projectRoot = projectScope?.rootPath;
    if (mutation.profile === "main" && !projectRoot) {
      return {
        operationId: mutation.operationId,
        ok: false,
        configSaved: false,
        errors: [
          { code: "scope_not_writable", message: "project_unavailable" },
        ],
      };
    }

    const result =
      mutation.profile === "main" && projectScope
        ? await (
            this.mcpPolicyMutationProvider ??
            new DefaultMcpPolicyMutationProvider()
          ).mutateManagerPolicy(mutation, projectScope)
        : await mutateMcpConfigBatch(mutation, projectRoot);
    if (!result.ok) return result;

    if (mutation.profile === "ask-agent") {
      this.askAgentMcpConfigVersion += 1;
      await this.refreshAskAgentMcpConnections({
        interactiveForNewServers: false,
        trigger: "config-mutation",
        userInitiated: true,
      });
    } else {
      await this.refreshAllWorkspaceMcpConnections({
        interactiveForNewServers: true,
        trigger: "config-mutation",
        userInitiated: true,
      });
    }
    const configSnapshot = await this.buildMcpConfigSnapshot(
      mutation.profile,
      undefined,
      projectScope,
      this.getCurrentProjectMcpHub(projectScope),
    );
    return {
      ...result,
      configSnapshot,
      connectionOutcomes: this.buildMcpConnectionOutcomes(
        mutation,
        configSnapshot,
      ),
    };
  }

  public async submitBrowserMcpConfigServer(input: {
    profile: McpManagerProfile;
    scope: McpManagerScope;
    projectId?: string;
    server: McpManagerServerDraft;
    expectedRevision?: string;
    operationId?: string;
    allowMainProfileMutation?: boolean;
  }): Promise<McpConfigMutationResult> {
    const expectedRevision =
      input.expectedRevision ??
      (
        await this.buildMcpConfigSnapshot(
          input.profile,
          undefined,
          input.profile === "main"
            ? this.resolveMcpProjectScope(input.projectId)
            : undefined,
        )
      ).revision ??
      "";
    return this.submitMcpConfigMutation(
      {
        operationId: input.operationId ?? randomUUID(),
        profile: input.profile,
        scope: input.scope,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        expectedRevision,
        operations: [
          { kind: "upsert", server: input.server, conflictAction: "replace" },
        ],
      },
      { allowMainProfileMutation: input.allowMainProfileMutation },
    );
  }

  public async submitBrowserMcpConfigRemove(input: {
    profile: McpManagerProfile;
    scope: McpManagerScope;
    projectId?: string;
    serverName: string;
    expectedRevision?: string;
    operationId?: string;
    allowMainProfileMutation?: boolean;
  }): Promise<McpConfigMutationResult> {
    const expectedRevision =
      input.expectedRevision ??
      (
        await this.buildMcpConfigSnapshot(
          input.profile,
          undefined,
          input.profile === "main"
            ? this.resolveMcpProjectScope(input.projectId)
            : undefined,
        )
      ).revision ??
      "";
    return this.submitMcpConfigMutation(
      {
        operationId: input.operationId ?? randomUUID(),
        profile: input.profile,
        scope: input.scope,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        expectedRevision,
        operations: [{ kind: "remove", serverName: input.serverName }],
      },
      { allowMainProfileMutation: input.allowMainProfileMutation },
    );
  }

  public async submitBrowserMcpConfigOpenRaw(input: {
    profile: McpManagerProfile;
    scope: McpManagerScope;
    projectId?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const projectScope =
        input.profile === "main"
          ? this.resolveMcpProjectScope(input.projectId)
          : undefined;
      await this.openRawMcpConfig(input.profile, input.scope, projectScope);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async submitBrowserAttachFile(
    projectId?: string,
  ): Promise<{ files: string[] }> {
    const scope = projectId
      ? this.getAvailableBrowserProjectScope(projectId)
      : this.getCustomizationSelection()?.scope;
    if (!scope?.rootPath) return { files: [] };
    const workspaceRoot = vscode.Uri.file(scope.rootPath);
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
    try {
      const canonicalRoot = fs.realpathSync(scope.rootPath) as string;
      return {
        files: uris.flatMap((uri) => {
          try {
            const canonicalPath = fs.realpathSync(uri.fsPath) as string;
            const relative = path.relative(canonicalRoot, canonicalPath);
            return relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
              ? [relative]
              : [];
          } catch {
            return [];
          }
        }),
      };
    } catch {
      return { files: [] };
    }
  }

  public async resolveBrowserAttachmentPreviews(
    paths: string[],
    projectId: string,
  ): Promise<{ images: ResolvedAttachmentImagePreview[] }> {
    const scope = this.getAvailableBrowserProjectScope(projectId);
    if (!scope?.rootPath) return { images: [] };
    return {
      images: await resolveProjectImagePreviews(paths, scope.rootPath),
    };
  }

  public async submitBrowserOpenImageInEditor(input: {
    src: string;
    name?: string;
    mimeType?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.openImageInEditor(input);
      return { ok: true };
    } catch (err) {
      this.log(`[open-image] Failed to open browser image: ${err}`);
      return { ok: false, error: "image_unavailable" };
    }
  }

  public async submitBrowserOpenFile(
    filePath: string,
    line: number | undefined,
    projectId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const scope = this.getAvailableBrowserProjectScope(projectId);
    if (!scope?.rootPath) {
      return { ok: false, error: "project_unavailable" };
    }

    try {
      const canonicalRoot = fs.realpathSync(scope.rootPath) as string;
      const requestedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(scope.rootPath, filePath);
      const canonicalPath = fs.realpathSync(requestedPath) as string;
      if (!isPathWithinRoot(canonicalPath, canonicalRoot)) {
        return { ok: false, error: "path_outside_project" };
      }
      await this.revealPathInEditor(canonicalPath, line);
      return { ok: true };
    } catch (err) {
      this.log(`[error] Failed to open browser path: ${err}`);
      return { ok: false, error: "path_unavailable" };
    }
  }

  private async openImageInEditor(input: {
    src: string;
    name?: string;
    mimeType?: string;
  }): Promise<void> {
    const match =
      /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(input.src);
    if (!match) throw new Error("invalid_image_data");

    const mimeType = match[1].toLowerCase();
    if (input.mimeType && input.mimeType.toLowerCase() !== mimeType) {
      throw new Error("image_mime_mismatch");
    }
    const extension = EDITOR_IMAGE_EXTENSION_BY_MIME.get(mimeType);
    if (!extension) throw new Error("unsupported_image_type");

    const data = Buffer.from(match[2], "base64");
    if (data.byteLength === 0 || data.byteLength > MAX_EDITOR_IMAGE_BYTES) {
      throw new Error("invalid_image_size");
    }

    this.editorImageTempDirectory ??= await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "agentlink-image-editor-"),
    );
    const inputName = input.name ?? "agentlink-image";
    const requestedStem = path.basename(inputName, path.extname(inputName));
    const safeStem =
      requestedStem.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) ||
      "agentlink-image";
    const imagePath = path.join(
      this.editorImageTempDirectory,
      `${safeStem}-${randomUUID()}.${extension}`,
    );
    await fs.promises.writeFile(imagePath, data, { flag: "wx" });
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(imagePath),
      withPrimaryEditorColumn({ preview: false }),
    );
  }

  private async revealPathInEditor(
    absolutePath: string,
    line?: number,
  ): Promise<void> {
    const uri = vscode.Uri.file(absolutePath);
    const stat = await fs.promises.stat(absolutePath);
    if (stat.isDirectory()) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }

    const options: vscode.TextDocumentShowOptions = withPrimaryEditorColumn();
    if (line !== undefined && Number.isInteger(line) && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }
    try {
      await vscode.window.showTextDocument(uri, options);
    } catch (err) {
      // Binary files (images, media, custom-editor formats) cannot be opened
      // as text documents; route them through VS Code's default editor
      // resolution instead (image preview, notebook editor, hex, ...).
      this.log(
        `[open-file] showTextDocument failed for ${absolutePath}, falling back to vscode.open: ${err}`,
      );
      await vscode.commands.executeCommand("vscode.open", uri, options);
    }
  }

  /**
   * Stop or replace a running foreground turn and clear any pending UI prompts
   * (questions, approvals, elicitations) that belong to it, then notify the
   * webview so it exits streaming state. Explicit stops cancel the owned
   * background subtree; steering preserves it.
   */
  private stopSessionFromUi(
    sessionId: string,
    opts?: {
      drainBrowserQueue?: boolean;
      preserveBackgroundAgents?: boolean;
    },
  ): void {
    if (!this.sessionManager) return;
    const session = this.sessionManager.getSession(sessionId);
    if (opts?.preserveBackgroundAgents) {
      this.sessionManager.interruptSession(sessionId);
    } else {
      this.sessionManager.stopSession(sessionId);
    }
    // Clear any active agent tool calls from the sidebar tracker
    this.toolCallTracker?.clearAgentCalls(sessionId);
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
          this.questionSessionById.delete(id);
          this.clearQuestionAttention(id);
          resolve({ answers: {}, notes: {} });
          this.uiPublisher.publishQuestionCleared(sessionId, id);
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
          this.clearApprovalRequest(sessionId, id);
        }
      }
      this.approvalSessionIndex.delete(sessionId);
    }

    this.formElicitationCoordinator.cancelSession(sessionId);
    // Immediately notify the webview so it exits streaming state
    this.postMessage({
      type: "agentDone",
      sessionId,
      totalInputTokens: session?.totalInputTokens ?? 0,
      totalOutputTokens: session?.totalOutputTokens ?? 0,
      totalCacheReadTokens: session?.totalCacheReadTokens ?? 0,
      totalCacheCreationTokens: session?.totalCacheCreationTokens ?? 0,
    });
    if (session?.background !== true && opts?.drainBrowserQueue !== false) {
      this.drainBrowserQueuedMessage(sessionId);
    }
    // If this was a bg session, push updated status so the strip/block
    // shows the cancelled state immediately.
    if (session?.background) {
      this.sendBgSessionsUpdate();
    }
  }

  private async steerQueuedMessageFromUi(input: {
    sessionId: string;
    queueId: string;
    text: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments: string[];
    source?: "vscode" | "browser";
    images: Array<{ name: string; mimeType: string; base64: string }>;
    documents: Array<{ name: string; mimeType: string; base64: string }>;
  }): Promise<void> {
    if (!input.sessionId || !input.queueId || !this.sessionManager) return;
    const session = this.sessionManager.getSession(input.sessionId);
    if (!session) return;

    this.applyProjectedAction({
      type: "REMOVE_FROM_QUEUE",
      id: input.queueId,
    });
    this.postMessage({
      type: "agentRemoveQueuedMessage",
      sessionId: input.sessionId,
      queueId: input.queueId,
    });

    const isRunning =
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval";
    if (isRunning) {
      this.stopSessionFromUi(input.sessionId, {
        drainBrowserQueue: false,
        preserveBackgroundAgents: true,
      });
    }

    const projectRoot = this.getSessionProjectRoot(input.sessionId);
    if (!projectRoot) return;
    const resolved = await this.resolveAttachments(
      input.text,
      input.attachments,
      projectRoot,
    );
    const images = [...input.images, ...resolved.images];
    const documents = [...input.documents, ...resolved.documents];
    const displayText = input.displayText ?? input.text;
    const reasoningEffort = session.reasoningEffort;
    const thinkingEnabled = reasoningEffort !== "none";
    const displayMedia = mediaToDisplayMedia({
      images,
      documents,
    });

    this.postMessage({
      type: "agentCommittedUserMessage",
      sessionId: input.sessionId,
      text: resolved.text,
      displayText,
      isSlashCommand: input.isSlashCommand,
      slashCommandLabel: input.slashCommandLabel,
      origin: input.source === "browser" ? "browser" : "vscode",
      displayMedia,
    });

    this.sessionManager
      .sendMessage(input.sessionId, resolved.text, session.mode, {
        thinkingEnabled,
        reasoningEffort,
        activeFilePath: session.activeFilePath,
        displayText,
        isSlashCommand: input.isSlashCommand,
        slashCommandLabel: input.slashCommandLabel,
        origin: input.source === "browser" ? "browser" : "vscode",
        images: images.length > 0 ? images : undefined,
        documents: documents.length > 0 ? documents : undefined,
      })
      .catch((err) => {
        this.log(`[error] steer queued message failed: ${err}`);
      });

    const fg = this.sessionManager.getForegroundSession();
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
          ...this.getBrowserSessionApprovalMode(),
          configuredCommandApprovalPolicy:
            this.getConfiguredCommandApprovalPolicy(),
        },
      });
    }
  }

  private interjectQueuedMessageFromUi(input: {
    sessionId: string;
    queueId: string;
    text: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments: string[];
    images: Array<{ name: string; mimeType: string; base64: string }>;
    documents: Array<{ name: string; mimeType: string; base64: string }>;
  }): boolean {
    if (!input.sessionId || !input.queueId || !this.sessionManager) {
      return false;
    }
    const session = this.sessionManager.getSession(input.sessionId);
    if (!session) return false;

    const isRunning =
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval";
    if (!isRunning) return false;

    const accepted = session.setPendingInterjection(
      input.text,
      input.queueId,
      undefined,
      input.displayText,
      input.isSlashCommand,
      input.slashCommandLabel,
      input.attachments.length > 0 ? input.attachments : undefined,
      input.images.length > 0 ? input.images : undefined,
      input.documents.length > 0 ? input.documents : undefined,
    );
    if (accepted) {
      this.applyProjectedAction({
        type: "MARK_QUEUE_INTERJECTION_READY",
        id: input.queueId,
        ready: true,
      });
      this.postMessage({
        type: "agentQueueInterjectionReady",
        sessionId: input.sessionId,
        queueId: input.queueId,
        ready: true,
      });
    }
    return accepted;
  }

  private pauseQueuedMessageInterjectionFromUi(
    sessionId: string,
    queueId: string,
  ): void {
    if (!sessionId || !queueId || !this.sessionManager) return;
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    session.clearPendingInterjectionIf(queueId);
    this.applyProjectedAction({
      type: "MARK_QUEUE_INTERJECTION_READY",
      id: queueId,
      ready: false,
    });
    this.postMessage({
      type: "agentQueueInterjectionReady",
      sessionId,
      queueId,
      ready: false,
    });
  }

  public async submitBrowserSteerQueuedMessage(input: {
    sessionId: string;
    projectId: string;
    queueId: string;
    text: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  }): Promise<{ ok: boolean }> {
    if (!input.sessionId || !input.queueId) return { ok: false };
    const session = this.sessionManager?.getSession(input.sessionId);
    if (
      !session ||
      session.projectScope.projectId !== input.projectId ||
      !this.getAvailableBrowserProjectScope(input.projectId)
    ) {
      return { ok: false };
    }
    const queued = this.projectedForegroundState.messageQueue.find(
      (entry) => entry.id === input.queueId && entry.source === "browser",
    );
    if (!queued) return { ok: false };
    await this.steerQueuedMessageFromUi({
      sessionId: input.sessionId,
      queueId: input.queueId,
      text: input.text,
      displayText: input.displayText,
      isSlashCommand: input.isSlashCommand,
      slashCommandLabel: input.slashCommandLabel,
      attachments: input.attachments ?? [],
      images: input.images ?? [],
      documents: input.documents ?? [],
      source: "browser",
    });
    return { ok: true };
  }

  public pauseBrowserQueuedMessageInterjection(input: {
    sessionId: string;
    projectId: string;
    queueId: string;
  }): { ok: boolean; error?: string } {
    if (!input.sessionId || !input.queueId) {
      return { ok: false, error: "invalid_request" };
    }
    const session = this.sessionManager?.getSession(input.sessionId);
    if (
      !session ||
      session.projectScope.projectId !== input.projectId ||
      !this.getAvailableBrowserProjectScope(input.projectId)
    ) {
      return { ok: false, error: "project_state_mismatch" };
    }
    const queued = this.projectedForegroundState.messageQueue.find(
      (entry) => entry.id === input.queueId,
    );
    if (!queued) return { ok: false, error: "queued_message_not_found" };
    this.pauseQueuedMessageInterjectionFromUi(input.sessionId, input.queueId);
    return { ok: true };
  }

  public submitBrowserInterjectQueuedMessage(input: {
    sessionId: string;
    projectId: string;
    queueId: string;
    text: string;
    displayText?: string;
    isSlashCommand?: boolean;
    slashCommandLabel?: string;
    attachments?: string[];
    images?: Array<{ name: string; mimeType: string; base64: string }>;
    documents?: Array<{ name: string; mimeType: string; base64: string }>;
  }): { ok: boolean; error?: string } {
    if (!input.sessionId || !input.queueId) {
      return { ok: false, error: "invalid_request" };
    }
    const session = this.sessionManager?.getSession(input.sessionId);
    if (
      !session ||
      session.projectScope.projectId !== input.projectId ||
      !this.getAvailableBrowserProjectScope(input.projectId)
    ) {
      return { ok: false, error: "project_state_mismatch" };
    }
    const queued = this.projectedForegroundState.messageQueue.find(
      (entry) => entry.id === input.queueId && entry.source === "browser",
    );
    if (!queued) return { ok: false, error: "queued_message_not_found" };
    const accepted = this.interjectQueuedMessageFromUi({
      sessionId: input.sessionId,
      queueId: input.queueId,
      text: input.text,
      displayText: input.displayText,
      isSlashCommand: input.isSlashCommand,
      slashCommandLabel: input.slashCommandLabel,
      attachments: input.attachments ?? [],
      images: input.images ?? [],
      documents: input.documents ?? [],
    });
    return accepted
      ? { ok: true }
      : { ok: false, error: "interjection_unavailable" };
  }

  /** Retry the latest failed turn through the same path used by the VS Code webview. */
  public submitBrowserRetry(
    sessionId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!sessionId || !this.sessionManager) {
      return { ok: false, error: "session_unavailable" };
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.background) {
      return { ok: false, error: "session_not_found" };
    }
    if (session.status !== "error") {
      return { ok: false, error: "session_not_retryable" };
    }
    if (this.pendingRetrySessionIds.has(sessionId)) {
      return { ok: false, error: "retry_in_progress" };
    }

    this.pendingRetrySessionIds.add(sessionId);
    this.log(`[retry] retrying session ${sessionId}`);
    if (this.sessionManager.getForegroundSession()?.id === sessionId) {
      this.applyProjectedAction({ type: "CLEAR_ERROR" });
    }
    void this.sessionManager
      .retrySession(sessionId)
      .catch((err) => {
        this.log(`[error] retry failed: ${err}`);
      })
      .finally(() => {
        this.pendingRetrySessionIds.delete(sessionId);
      });
    return { ok: true };
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

  /** Resume an interrupted interactive session through the manager's safe path. */
  public async submitBrowserResume(
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!sessionId || !this.sessionManager) {
      return { ok: false, error: "session_unavailable" };
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.background) {
      return { ok: false, error: "session_not_found" };
    }
    if (!session.runState || session.runState.phase === "awaiting_question") {
      return { ok: false, error: "session_not_interrupted" };
    }
    if (session.status !== "idle" && session.status !== "error") {
      return { ok: false, error: "session_busy" };
    }
    try {
      const resumed =
        await this.sessionManager.resumeInterruptedSession(sessionId);
      if (!resumed) {
        this.sendInitialState();
        return { ok: false, error: "resume_not_started" };
      }
      return { ok: true };
    } catch (error) {
      this.log(`[error] browser resume failed: ${String(error)}`);
      this.sendInitialState();
      return { ok: false, error: "resume_failed" };
    }
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

  public async submitBrowserBackgroundAction(input: {
    action:
      | "steer"
      | "detach"
      | "retry"
      | "archive"
      | "pause"
      | "resume"
      | "mark_read";
    sessionId: string;
    message?: string;
  }): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    if (!this.sessionManager) return { ok: false, error: "unavailable" };
    const foregroundId = this.sessionManager.getForegroundSession()?.id;
    if (input.action === "steer" && foregroundId) {
      const result = this.sessionManager.steerAuthorizedBackground(
        foregroundId,
        input.sessionId,
        input.message ?? "",
      );
      return { ok: result.accepted, error: result.reason };
    }
    if (input.action === "detach" && foregroundId) {
      const result = this.sessionManager.detachAuthorizedBackground(
        foregroundId,
        input.sessionId,
      );
      return { ok: result.detached, error: result.reason };
    }
    if (input.action === "archive") {
      const result = this.sessionManager.archiveBackground(input.sessionId);
      return { ok: result.archived, error: result.reason };
    }
    if (input.action === "mark_read") {
      this.sessionManager.markFleetEventsRead(input.sessionId);
      return { ok: true };
    }
    if (input.action === "pause") {
      const result = this.sessionManager.pauseBackground(input.sessionId);
      return { ok: result.paused, error: result.reason };
    }
    if (input.action === "resume") {
      try {
        const result = await this.sessionManager.resumeBackground(
          input.sessionId,
        );
        return { ok: true, sessionId: result.sessionId };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }
    if (input.action === "retry") {
      try {
        const result = await this.sessionManager.retryBackground(
          input.sessionId,
        );
        return { ok: true, sessionId: result.sessionId };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }
    return { ok: false, error: "invalid_action" };
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
    const messages =
      this.sessionManager.getBackgroundTranscriptMessages(sessionId);
    if (!session || !messages) return { ok: false };
    return {
      ok: true,
      transcript: {
        sessionId,
        task: session.title ?? "Background Agent",
        messages: stripMediaForTransport(messages),
      },
    };
  }

  private getSessionProjectRoot(sessionId: string): string | undefined {
    const session = this.sessionManager?.getSession(sessionId);
    const scope = session?.projectScope;
    if (
      !session ||
      !scope?.rootPath ||
      (session.projectAvailability !== undefined &&
        session.projectAvailability !== "available")
    ) {
      return undefined;
    }

    const projects = this.sessionManager?.getWorkspaceProjects?.();
    if (!projects) return scope.rootPath;
    const project = projects.find(
      (candidate) => candidate.id === scope.projectId,
    );
    return project?.availability.status === "available" &&
      project.uri === scope.workspaceFolderUri &&
      project.rootPath === scope.rootPath
      ? scope.rootPath
      : undefined;
  }

  private getAvailableBrowserProjectScope(
    projectId: string,
  ): SessionProjectScope | undefined {
    const project = this.sessionManager
      ?.getWorkspaceProjects?.()
      .find((candidate) => candidate.id === projectId);
    return project?.availability.status === "available" && project.rootPath
      ? createSessionProjectScope(project)
      : undefined;
  }

  public async getBrowserSlashCommands(
    projectId: string,
  ): Promise<SlashCommandInfo[]> {
    const scope = this.getAvailableBrowserProjectScope(projectId);
    if (!scope) return [];
    const session = this.sessionManager?.getForegroundSession();
    const mode =
      session?.projectScope.projectId === projectId ? session.mode : "code";
    return this.projectCustomizationRegistry.getSlashCommands(scope, mode);
  }

  public async searchBrowserFiles(
    query: string,
    projectId: string,
  ): Promise<Array<{ path: string; kind: "file" | "folder" }>> {
    const scope = this.getAvailableBrowserProjectScope(projectId);
    if (!scope?.rootPath) return [];

    try {
      const { pattern, effectiveQuery } = buildFileSearchPattern(
        query,
        scope.rootPath,
      );
      const include = new vscode.RelativePattern(scope.rootPath, pattern);
      // VS Code can opt workspace.findFiles into respecting .gitignore. Keep
      // the normal query for fast/common results, then merge a documented
      // `exclude: null` query so ignored project files remain mentionable.
      const [normalUris, allUris] = await Promise.all([
        vscode.workspace.findFiles(include, "**/node_modules/**", 50),
        vscode.workspace.findFiles(include, null, 200),
      ]);

      const filesByPath = new Map<string, { path: string; kind: "file" }>();
      for (const uri of [...normalUris, ...allUris]) {
        const relativePath = path.relative(scope.rootPath, uri.fsPath);
        const segments = relativePath.split(path.sep);
        if (
          !relativePath ||
          path.isAbsolute(relativePath) ||
          relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          segments.includes(".git") ||
          segments.includes("node_modules")
        ) {
          continue;
        }
        const displayPath = relativePath.split(path.sep).join("/");
        filesByPath.set(displayPath, {
          path: displayPath,
          kind: "file",
        });
      }
      const files = [...filesByPath.values()];

      const lowerQuery = path.posix.basename(effectiveQuery).toLowerCase();
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

  public async getBrowserModes(
    projectId: string,
  ): Promise<Array<{ slug: string; name: string; icon: string }>> {
    const scope = this.getAvailableBrowserProjectScope(projectId);
    if (!scope) return [];
    const allModes = await this.projectCustomizationRegistry.getModes(scope);
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
      providerDisplayName: m.providerDisplayName,
      supportsToolUse: m.supportsToolUse ?? m.capabilities.supportsToolUse,
      supportsImages: m.supportsImages ?? m.capabilities.supportsImages,
      contextWindow: m.capabilities.contextWindow,
      maxInputTokens: m.capabilities.maxInputTokens,
      maxOutputTokens: m.capabilities.maxOutputTokens,
      reasoningEfforts: m.capabilities.reasoningEfforts,
      defaultReasoningEffort: m.capabilities.defaultReasoningEffort,
      authenticated: authStatus[m.provider] ?? false,
      condenseThreshold: this.getConfiguredCondenseThreshold(m.id),
    }));
  }

  private setupFileWatchers(
    scope: SessionProjectScope,
    refreshMainMcp: boolean,
  ): void {
    const cwd = scope.rootPath;
    if (!cwd || this.watchedCustomizationProjectIds.has(scope.projectId))
      return;
    this.watchedCustomizationProjectIds.add(scope.projectId);

    const configPattern = new vscode.RelativePattern(
      cwd,
      "{.agents,.claude,.codex,.agentlink}/{commands/**,modes.json,mcp.json,hooks.json}",
    );
    const configWatcher =
      vscode.workspace.createFileSystemWatcher(configPattern);
    const reloadConfig = () => {
      this.projectCustomizationRegistry.invalidate(scope.projectId);
      if (
        this.getCustomizationSelection()?.scope.projectId === scope.projectId
      ) {
        void this.sendSlashCommands();
        void this.sendModesUpdate();
      }
      this.sessionManager?.invalidateHookConfiguration(scope.projectId);
      if (refreshMainMcp) {
        void this.refreshAllWorkspaceMcpConnections({
          interactiveForNewServers: true,
          trigger: "config-watcher",
        });
      }
    };
    configWatcher.onDidChange(reloadConfig);
    configWatcher.onDidCreate(reloadConfig);
    configWatcher.onDidDelete(reloadConfig);
    this.fileWatchers.push(configWatcher);

    const refreshSkills = () => {
      void this.refreshSkillConfiguration(scope.projectId);
    };
    const repositoryRoot = getSkillDiscoveryRoots(cwd)[0] ?? cwd;
    const repositorySkillWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        repositoryRoot,
        "**/{.agents,.claude,.agentlink}/{skills/**,skills-*/**}",
      ),
    );
    repositorySkillWatcher.onDidChange(refreshSkills);
    repositorySkillWatcher.onDidCreate(refreshSkills);
    repositorySkillWatcher.onDidDelete(refreshSkills);
    this.fileWatchers.push(repositorySkillWatcher);
    if (!this.globalSkillWatchersInitialized) {
      this.globalSkillWatchersInitialized = true;
      const refreshGlobalSkills = () => {
        void this.refreshSkillConfiguration();
      };
      const home = os.homedir();
      for (const namespace of [".agents", ".claude", ".agentlink"]) {
        const globalSkillWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            path.join(home, namespace),
            "{skills/**,skills-*/**}",
          ),
        );
        globalSkillWatcher.onDidChange(refreshGlobalSkills);
        globalSkillWatcher.onDidCreate(refreshGlobalSkills);
        globalSkillWatcher.onDidDelete(refreshGlobalSkills);
        this.fileWatchers.push(globalSkillWatcher);
      }
    }

    if (!this.globalHookWatchersInitialized) {
      this.globalHookWatchersInitialized = true;
      const home = os.homedir();
      for (const namespace of [".agents", ".claude", ".codex", ".agentlink"]) {
        const globalHookWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(path.join(home, namespace), "hooks.json"),
        );
        const reloadGlobalHooks = () =>
          this.sessionManager?.invalidateHookConfiguration();
        globalHookWatcher.onDidChange(reloadGlobalHooks);
        globalHookWatcher.onDidCreate(reloadGlobalHooks);
        globalHookWatcher.onDidDelete(reloadGlobalHooks);
        this.fileWatchers.push(globalHookWatcher);
      }
    }

    if (!this.mainGlobalMcpWatchersInitialized) {
      this.mainGlobalMcpWatchersInitialized = true;
      for (const filePath of getGlobalMcpConfigPaths()) {
        const globalMcpWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            path.dirname(filePath),
            path.basename(filePath),
          ),
        );
        const reloadGlobalMcp = () => {
          void this.refreshAllWorkspaceMcpConnections({
            interactiveForNewServers: true,
            trigger: "config-watcher",
          });
        };
        globalMcpWatcher.onDidChange(reloadGlobalMcp);
        globalMcpWatcher.onDidCreate(reloadGlobalMcp);
        globalMcpWatcher.onDidDelete(reloadGlobalMcp);
        this.fileWatchers.push(globalMcpWatcher);
      }
    }

    if (!this.askAgentMcpWatchersInitialized) {
      this.askAgentMcpWatchersInitialized = true;
      for (const filePath of getAskAgentMcpConfigPaths()) {
        const askAgentMcpWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            path.dirname(filePath),
            path.basename(filePath),
          ),
        );
        const reloadAskAgentMcp = () => {
          void this.refreshAskAgentMcpConnections({
            interactiveForNewServers: true,
            trigger: "config-watcher",
          });
        };
        askAgentMcpWatcher.onDidChange(reloadAskAgentMcp);
        askAgentMcpWatcher.onDidCreate(reloadAskAgentMcp);
        askAgentMcpWatcher.onDidDelete(reloadAskAgentMcp);
        this.fileWatchers.push(askAgentMcpWatcher);
      }
    }

    // Watch instruction files for system prompt hot-reload
    const instructionPattern = new vscode.RelativePattern(
      cwd,
      "{AGENTS.md,AGENT.md,CLAUDE.md,AGENTS.local.md,.claude/CLAUDE.md,.agentlink/AGENTS.md,.agentlink/CLAUDE.md,.agentlink/memory.md,.agents/rules/**/*.md,.agentlink/rules/**/*.md,.agentlink/rules-*/**/*.md,.agents/rules-*/**/*.md,**/AGENTS.md,**/AGENT.md,**/AGENTS.local.md}",
    );
    const instructionWatcher =
      vscode.workspace.createFileSystemWatcher(instructionPattern);
    const reloadInstructions = () => {
      this.projectCustomizationRegistry.invalidate(scope.projectId);
      void this.rebuildSessionSystemPrompts(scope.projectId);
    };
    instructionWatcher.onDidChange(reloadInstructions);
    instructionWatcher.onDidCreate(reloadInstructions);
    instructionWatcher.onDidDelete(reloadInstructions);
    this.fileWatchers.push(instructionWatcher);
  }

  public refreshSkillConfiguration(projectId?: string): Promise<void> {
    const refresh = this.skillRefreshTail
      .catch(() => undefined)
      .then(async () => {
        if (!(await this.rebuildSessionSystemPrompts(projectId))) return;
        if (projectId) {
          this.slashCatalogProjectGenerations.set(
            projectId,
            (this.slashCatalogProjectGenerations.get(projectId) ?? 0) + 1,
          );
          this.projectCustomizationRegistry.invalidate(projectId);
        } else {
          this.slashCatalogGlobalGeneration += 1;
          this.projectCustomizationRegistry.clear();
        }
        const selection = this.getCustomizationSelection();
        if (!projectId || selection?.scope.projectId === projectId) {
          await this.sendSlashCommands();
        }
      });
    this.skillRefreshTail = refresh;
    return refresh;
  }

  private async rebuildSessionSystemPrompts(
    projectId?: string,
  ): Promise<boolean> {
    if (!this.sessionManager) return true;
    try {
      await this.sessionManager.rebuildSystemPrompts(projectId);
      this.log(
        "[instructions] Rebuilt system prompt after instruction file change",
      );
      return true;
    } catch (err) {
      this.log(`[instructions] Failed to rebuild system prompt: ${err}`);
      return false;
    }
  }

  private async sendModesUpdate(): Promise<void> {
    const selection = this.getCustomizationSelection();
    const selectionKey = this.getCustomizationSelectionKey(selection);
    const hasWorkspaceProjects = this.hasWorkspaceProjects();
    const allModes = selection
      ? await this.projectCustomizationRegistry.getModes(selection.scope)
      : hasWorkspaceProjects
        ? BUILT_IN_MODES
        : BUILT_IN_MODES.filter((mode) => mode.slug === "ask");
    if (
      selectionKey !==
      this.getCustomizationSelectionKey(this.getCustomizationSelection())
    ) {
      return;
    }
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
    this.postMessage({
      type: "agentModelsUpdate",
      models: await this.getBrowserModels(),
    });
  }

  private async sendSlashCommands(): Promise<void> {
    const selection = this.getCustomizationSelection();
    const globalGeneration = this.slashCatalogGlobalGeneration;
    const projectGeneration = selection
      ? (this.slashCatalogProjectGenerations.get(selection.scope.projectId) ??
        0)
      : 0;
    if (!selection) {
      this.postMessage({
        type: "agentSlashCommandsUpdate",
        commands: [],
      } as ExtensionToWebview);
      return;
    }
    const selectionKey = this.getCustomizationSelectionKey(selection);
    const commands = await this.getCurrentSlashCommands(selection);
    if (
      globalGeneration !== this.slashCatalogGlobalGeneration ||
      projectGeneration !==
        (this.slashCatalogProjectGenerations.get(selection.scope.projectId) ??
          0) ||
      selectionKey !==
        this.getCustomizationSelectionKey(this.getCustomizationSelection())
    ) {
      return;
    }
    this.postMessage({
      type: "agentSlashCommandsUpdate",
      commands,
    } as ExtensionToWebview);
  }

  private getCustomizationSelection(
    session = this.sessionManager?.getForegroundSession(),
  ): { scope: SessionProjectScope; mode: string } | undefined {
    if (session) {
      const scope = session.projectScope;
      if (!scope) return undefined;
      if (session.projectAvailability !== "available" || !scope.rootPath) {
        return undefined;
      }
      return { scope, mode: session.mode };
    }

    const managerDefaultScope =
      typeof this.sessionManager?.getDefaultProjectScope === "function"
        ? this.sessionManager.getDefaultProjectScope()
        : undefined;
    const scope = managerDefaultScope ?? this.initialProjectScope;
    return scope?.rootPath ? { scope, mode: "code" } : undefined;
  }

  private getCustomizationSelectionKey(
    selection: { scope: SessionProjectScope; mode: string } | undefined,
  ): string {
    return selection
      ? `${selection.scope.projectId}:${selection.scope.workspaceFolderUri}:${selection.mode}`
      : "unavailable";
  }

  private async getCurrentSlashCommands(
    selection = this.getCustomizationSelection(),
  ): Promise<SlashCommandInfo[]> {
    return selection
      ? this.projectCustomizationRegistry.getSlashCommands(
          selection.scope,
          selection.mode,
        )
      : [];
  }

  private async getModesForSession(
    session: AgentSession,
  ): Promise<Array<{ slug: string; name: string; icon: string }>> {
    const selection = this.getCustomizationSelection(session);
    const allModes = selection
      ? await this.projectCustomizationRegistry.getModes(selection.scope)
      : this.hasWorkspaceProjects()
        ? BUILT_IN_MODES
        : BUILT_IN_MODES.filter((mode) => mode.slug === "ask");
    return allModes.map((mode) => ({
      slug: mode.slug,
      name: mode.name,
      icon: mode.icon,
    }));
  }

  private getSlashCommandsForSession(
    session: AgentSession,
  ): Promise<SlashCommandInfo[]> {
    return this.getCurrentSlashCommands(
      this.getCustomizationSelection(session),
    );
  }

  private getWorkspaceProjects(): ReturnType<
    AgentSessionManager["getWorkspaceProjects"]
  > {
    return this.sessionManager?.getWorkspaceProjects?.() ?? [];
  }

  private hasWorkspaceProjects(): boolean {
    const getWorkspaceProjects = this.sessionManager?.getWorkspaceProjects;
    return typeof getWorkspaceProjects !== "function"
      ? true
      : getWorkspaceProjects.call(this.sessionManager).length > 0;
  }

  private getProjectInfos(): ProjectInfo[] {
    return this.getWorkspaceProjects().map((project) => ({
      projectId: project.id,
      displayName: project.name,
      availability:
        project.availability.status === "available"
          ? "available"
          : "unavailable",
    }));
  }

  private getWebviewSessionSummaries(): WebviewSessionSummary[] {
    const projects = new Map(
      this.getProjectInfos().map((project) => [project.projectId, project]),
    );
    return (this.sessionManager?.listPersistedSessions() ?? []).map(
      (session) => {
        const projectId = session.projectScope?.projectId;
        const project = projectId
          ? (projects.get(projectId) ?? {
              projectId,
              displayName:
                session.projectScope?.displayName ?? "Project unavailable",
              availability: "unavailable" as const,
            })
          : undefined;
        return {
          id: session.id,
          project,
          mode: session.mode,
          model: session.model,
          title: session.title,
          messageCount: session.messageCount,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
        };
      },
    );
  }

  private sendSessionList(): void {
    this.postMessage({
      type: "agentSessionList",
      sessions: this.getWebviewSessionSummaries(),
    });
  }

  private getConfiguredCondenseThreshold(
    modelId: string,
    projectScope?: SessionProjectScope,
  ): number {
    return getConfiguredBaseThresholdForModel(
      this.getProjectConfiguration(projectScope) ??
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

    const config = this.sessionManager?.getConfig?.();
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

  setWorkspaceHistoryDiagnostic(
    getDiagnostic: () => WorkspaceHistoryLocationDiagnostic,
  ): void {
    this.workspaceHistoryDiagnostic = getDiagnostic;
  }

  showWorkspaceHistory(): void {
    const diagnostic = this.workspaceHistoryDiagnostic?.();
    if (!diagnostic) {
      void vscode.window.showInformationMessage(
        "AgentLink workspace history is not available yet.",
      );
      return;
    }
    const lines = [
      "AgentLink Workspace History",
      `Status: ${diagnostic.status}`,
      `Location: ${diagnostic.directory ?? "Unavailable"}`,
      `Storage: ${diagnostic.label}`,
      `Workspace identity: ${diagnostic.workspaceIdentity}`,
      ...(diagnostic.stateAnchor
        ? [`State anchor: ${diagnostic.stateAnchor.rootPath}`]
        : []),
      ...(diagnostic.conflictingLegacyRoots
        ? [
            `Conflicting legacy roots: ${diagnostic.conflictingLegacyRoots.join(", ")}`,
          ]
        : []),
    ];
    this.outputChannel.appendLine(lines.join("\n"));
    this.outputChannel.show(true);
  }

  setChatTabStartupRestore(restore: Promise<unknown>): void {
    this.chatTabStartupRestore = restore;
    this.chatTabStartupRestoreSettled = false;
    const markSettled = () => {
      if (this.chatTabStartupRestore === restore) {
        this.chatTabStartupRestoreSettled = true;
      }
    };
    void restore.then(markSettled, markSettled);
  }

  setChatTabController(controller: ChatTabController): void {
    this.chatTabControllerListener?.dispose();
    this.chatTabController = controller;
    this.refreshChatTabHostCoordinator();
    this.chatTabControllerListener = controller.onDidChangeWorkspace(() => {
      this.sendChatWorkspaceUpdate();
      const visibleRequest = this.visibleApprovalId
        ? this.activeApprovalRequests.get(this.visibleApprovalId)
        : undefined;
      if (visibleRequest?.backgroundTask) this.publishVisibleApproval();
    });
    this.sendChatWorkspaceUpdate();
  }

  setChatTabPanelHost(host: ChatTabPanelHost): void {
    this.chatTabPanelHost = host;
  }

  refreshChatWorkspace(): void {
    this.sendChatWorkspaceUpdate();
  }

  async focusPendingInteraction(sessionId: string): Promise<boolean> {
    const controller = this.chatTabController;
    const coordinator = this.chatTabHostCoordinator;
    if (!controller || !coordinator) return false;

    let targetSessionId: string | undefined = sessionId;
    let tab: ChatTab | undefined;
    const visited = new Set<string>();
    while (targetSessionId && !visited.has(targetSessionId)) {
      visited.add(targetSessionId);
      tab = controller.getTabForSession(targetSessionId);
      if (tab) break;
      targetSessionId =
        this.sessionManager?.getBackgroundParentSessionId(targetSessionId);
    }
    if (!tab || !targetSessionId) {
      if (!this.sessionManager?.getSession(sessionId)) return false;
      this.revealPanel(false);
      return true;
    }
    if (tab.placement === "popped") {
      return this.chatTabPanelHost?.focusPanel(tab.id) === true;
    }

    const result = await coordinator.focus({
      controllerEpoch: controller.getWorkspaceSnapshot().controllerEpoch,
      tabId: tab.id,
      sessionId: targetSessionId,
    });
    if (!result.ok) return false;
    this.foregroundSessionTransition = undefined;
    this.sendChatWorkspaceUpdate();
    if (result.session) {
      this.postSessionLoaded(result.session, {
        checkpoints: this.getSessionCheckpoints(result.session.id),
        origin: "focus",
      });
    }
    this.sendInitialState();
    this.revealPanel(false);
    if (result.session) {
      await this.sendModesUpdate();
      await this.sendSlashCommands();
    }
    return true;
  }

  async hydrateEditorPane(
    tabId: string,
    connection: ChatPaneConnection,
  ): Promise<void> {
    const initialAddress = connection.getAddress();
    const initialTab = this.chatTabController?.getTab(tabId);
    const sessionId = initialAddress.sessionId;
    if (
      !initialTab ||
      initialAddress.surface !== "editor" ||
      initialAddress.tabId !== tabId ||
      typeof sessionId !== "string" ||
      sessionId !== initialTab.sessionId ||
      !this.chatTabPanelHost?.isRegisteredConnection(tabId, connection)
    ) {
      throw new Error("editor pane no longer owns the selected chat tab");
    }

    const session =
      this.sessionManager?.getSession(sessionId) ??
      (await this.sessionManager?.hydratePersistedSession(sessionId));
    const currentAddress = connection.getAddress();
    const currentTab = this.chatTabController?.getTab(tabId);
    if (
      !session ||
      !currentTab ||
      currentAddress.controllerEpoch !== initialAddress.controllerEpoch ||
      currentAddress.tabId !== initialAddress.tabId ||
      currentAddress.sessionId !== sessionId ||
      currentAddress.surface !== initialAddress.surface ||
      currentAddress.paneEpoch !== initialAddress.paneEpoch ||
      currentTab.sessionId !== sessionId ||
      !this.chatTabPanelHost?.isRegisteredConnection(tabId, connection)
    ) {
      throw new Error("editor pane no longer owns the selected chat tab");
    }

    const snapshot = this.getChatWorkspaceViewSnapshot();
    if (snapshot) {
      connection.postMessage({ type: "chatWorkspaceUpdate", snapshot });
    }
    connection.postMessage({
      type: "agentModesUpdate",
      modes: await this.getModesForSession(session),
    });
    connection.postMessage({
      type: "agentModelsUpdate",
      models: await this.getBrowserModels(),
    });
    connection.postMessage({
      type: "agentSlashCommandsUpdate",
      commands: await this.getSlashCommandsForSession(session),
    });
    connection.postMessage({
      type: "agentSessionList",
      sessions: this.getWebviewSessionSummaries(),
    });
    connection.postMessage(
      this.buildSessionLoadedMessage(session, {
        checkpoints: this.getSessionCheckpoints(session.id),
      }),
    );
    connection.postMessage({
      type: "stateUpdate",
      state: this.buildChatState(session),
    });
    for (const envelope of this.uiEventHub.getSnapshot(session.id)) {
      connection.postMessage({ ...envelope.event, sessionId: session.id });
    }
  }

  async hydrateSidebarPane(tabId: string, lease: ChatPaneLease): Promise<void> {
    if (
      lease.tabId !== tabId ||
      lease.surface !== "sidebar" ||
      !this.chatTabController?.getTab(tabId)
    ) {
      throw new Error("sidebar pane no longer owns the selected chat tab");
    }
  }

  async handleEditorPaneMessage(
    message: Record<string, unknown>,
    connection: ChatPaneConnection,
  ): Promise<void> {
    const address = connection.getAddress();
    if (!this.chatTabPanelHost?.isAuthoritativeAddress(address)) {
      this.log(
        `[chat-pane] Rejected non-authoritative editor command for ${address.tabId}:${address.paneEpoch}`,
      );
      return;
    }
    if (typeof address.sessionId !== "string") {
      this.log(
        `[chat-pane] Rejected editor command without a bound session for ${address.tabId}:${address.paneEpoch}`,
      );
      return;
    }
    await this.handleWebviewMessage(message, {
      sourceSessionId: address.sessionId,
      connection,
    });
  }

  setSessionManager(manager: AgentSessionManager): void {
    this.sessionManager = manager;
    this.refreshChatTabHostCoordinator();
    const projects =
      typeof manager.getWorkspaceProjects === "function"
        ? manager.getWorkspaceProjects()
        : [];
    for (const project of projects) {
      if (project.rootPath) {
        const scope = createSessionProjectScope(project);
        this.projectMcpHubRegistry.ensure(scope);
        this.setupFileWatchers(scope, true);
        void this.ensureStartupMcpConnection(scope);
      }
    }
    if (this.getCustomizationSelection()) {
      void this.sendModesUpdate();
      void this.sendSlashCommands();
    }

    manager.onEvent = (sessionId, event) => {
      this.handleAgentEvent(sessionId, event);
    };

    manager.onSessionsChanged = () => {
      this.reconcileQuestionAttention();
      // Session status can change outside the foreground event stream (for example
      // when a tracked tool is force-cancelled/completed from the sidebar). Push a
      // full foreground state refresh so the chat webview's streaming/session state
      // stays aligned with the real session status, then refresh the sidebar strips.
      if (this.getCustomizationSelection()) {
        void this.sendModesUpdate();
        void this.sendSlashCommands();
      }
      this.sendInitialState();
      this.sendChatWorkspaceUpdate();
      this.sendBgSessionsUpdate();
    };
    manager.onFleetEvent = (sessionId, event) => {
      this.postMessage({ type: "agentFleetEvent", sessionId, event });
    };
  }

  private refreshChatTabHostCoordinator(): void {
    this.chatTabHostCoordinator =
      this.chatTabController && this.sessionManager
        ? new ChatTabHostCoordinator(
            this.chatTabController,
            this.sessionManager,
          )
        : undefined;
  }

  private getChatWorkspaceViewSnapshot():
    | ChatWorkspaceViewSnapshot
    | undefined {
    if (!this.chatTabController || !this.sessionManager) return undefined;
    return createChatWorkspaceViewSnapshot(
      this.chatTabController.getWorkspaceSnapshot(),
      this.sessionManager.getSessionInfos(),
    );
  }

  private sendChatWorkspaceUpdate(): void {
    const snapshot = this.getChatWorkspaceViewSnapshot();
    if (!snapshot) return;
    this.postMessage({
      type: "chatWorkspaceUpdate",
      snapshot,
    });
  }

  private async reconcileForegroundChatTab(): Promise<void> {
    const foreground = this.sessionManager?.getForegroundSession();
    const controller = this.chatTabController;
    if (!foreground || !controller) return;
    const existing = controller.getTabForSession(foreground.id);
    if (existing) {
      if (existing.placement === "popped") {
        await controller.setPlacement(existing.id, "popped", "docked");
      }
      await controller.focusTab(existing.id);
      return;
    }
    await controller.createTab(foreground.id);
  }

  private async hydrateReadyWebview(): Promise<void> {
    this.updateBrowserGatewayThemeState(() => {
      this.webviewReady = true;
    });
    this.startHostHeartbeat();
    const initialSnapshot = this.getChatWorkspaceViewSnapshot();
    if (initialSnapshot) {
      this.postMessage({
        type: "chatWorkspaceUpdate",
        snapshot: initialSnapshot,
      });
    }
    void this.sendModesUpdate();
    void this.sendModelsUpdate();
    void this.sendSlashCommands();
    this.sendSessionList();
    this.flushPendingWebviewMessages();
    this.postMessage({ type: "agentRestoreSessionStart" });
    try {
      // Provisional fast paint: show the selected session's persisted tail
      // before the full transcript parse finishes. The complete hydration
      // below supersedes it (deterministic t<idx> ids keep the re-apply
      // visually stable).
      await this.postProvisionalRestoredTail();
    } catch (error) {
      this.log(
        `[session-restore] Provisional tail hydration failed: ${String(error)}`,
      );
    }

    try {
      await this.chatTabStartupRestore;
    } catch (error) {
      this.log(
        `[session-restore] Startup tab restore failed: ${String(error)}`,
      );
    }

    try {
      await this.reconcileForegroundChatTab();
      this.sendSessionList();
      const snapshot = this.getChatWorkspaceViewSnapshot();
      if (snapshot) {
        this.postMessage({ type: "chatWorkspaceUpdate", snapshot });
        const selectedSessionId = selectedWorkspaceSessionId(snapshot);
        const foreground = this.sessionManager?.getForegroundSession();
        if (selectedSessionId && foreground?.id === selectedSessionId) {
          const selected = this.sessionManager?.getSession(selectedSessionId);
          if (selected) {
            this.postSessionLoaded(selected, {
              restored: true,
              checkpoints: this.getSessionCheckpoints(selected.id),
            });
          }
        } else if (selectedSessionId || foreground) {
          this.log(
            `[session-restore] Selected tab and foreground session diverged (selected=${selectedSessionId ?? "none"}, foreground=${foreground?.id ?? "none"})`,
          );
          if (foreground) {
            this.postSessionLoaded(foreground, {
              restored: true,
              checkpoints: this.getSessionCheckpoints(foreground.id),
            });
          }
        }
      } else {
        const foreground = this.sessionManager?.getForegroundSession();
        if (foreground) {
          this.postSessionLoaded(foreground, {
            restored: true,
            checkpoints: this.getSessionCheckpoints(foreground.id),
          });
        }
      }
      this.sendInitialState();
      void this.sendDebugInfo();
    } finally {
      this.postMessage({ type: "agentRestoreSessionDone" });
    }
  }

  /**
   * Paint the selected tab's persisted transcript tail while the full startup
   * restore is still parsing transcripts. Best-effort: bails whenever the
   * session is already live, the restore has finished, or no valid tail
   * snapshot exists — in all of those cases the normal hydration path serves
   * the webview, just later.
   */
  private async postProvisionalRestoredTail(): Promise<void> {
    if (this.chatTabStartupRestoreSettled) return;
    const manager = this.sessionManager;
    if (!manager || typeof manager.readPersistedSessionTail !== "function") {
      return;
    }
    const snapshot = this.getChatWorkspaceViewSnapshot();
    const candidateId = snapshot
      ? selectedWorkspaceSessionId(snapshot)
      : manager.getForegroundSession()?.id;
    if (!candidateId || manager.getSession(candidateId)) return;
    const tail = await manager.readPersistedSessionTail(candidateId);
    if (!tail || tail.messages.length === 0) return;
    // The restore may have raced ahead while the tail was read; its complete
    // hydration is authoritative, so drop the provisional one.
    if (this.chatTabStartupRestoreSettled || manager.getSession(candidateId)) {
      return;
    }
    this.postMessage({
      type: "agentSessionLoaded",
      sessionId: candidateId,
      transcriptRevision: tail.transcriptRevision,
      title: tail.title,
      originalPrompt: projectFirstUserPrompt(
        tail.firstUserMessage ? [tail.firstUserMessage] : [],
      ),
      mode: tail.mode,
      model: tail.model,
      messages: tail.messages,
      messageIndexOffset: tail.messageIndexOffset,
      todos: tail.todos,
      lastInputTokens: tail.lastInputTokens ?? 0,
      lastOutputTokens: 0,
      restored: true,
      userTurnOffset: tail.userTurnOffset,
      hasMoreBefore: tail.hasMoreBefore,
      streaming: false,
      interrupted:
        tail.runStatePhase !== undefined &&
        tail.runStatePhase !== "awaiting_question",
    });
  }

  private rejectChatTabAction(
    command: string,
    reason: ChatTabActionRejection["reason"],
    address?: ChatTabActionAddress,
  ): void {
    const snapshot = this.getChatWorkspaceViewSnapshot();
    if (!snapshot) return;
    this.log(`[chat-tabs] rejected command=${command} reason=${reason}`);
    this.postChatTabActionMessage(
      {
        type: "chatTabActionRejected",
        rejection: { command, reason, snapshot },
      },
      address,
    );
  }

  private async handleChatTabPlacementAction(
    command: "chatTabPopOut" | "chatTabDock",
    msg: Record<string, unknown>,
  ): Promise<void> {
    const address = parseChatTabActionAddress(msg);
    const controller = this.chatTabController;
    const host = this.chatTabPanelHost;
    if (!address || !controller || !host) {
      this.rejectChatTabAction(
        command,
        "invalid_address",
        address ?? undefined,
      );
      return;
    }
    const validation = controller.validateAction(address);
    if (!validation.ok) {
      this.rejectChatTabAction(command, validation.reason, address);
      return;
    }

    const changed =
      command === "chatTabPopOut"
        ? await host.popOut(address.tabId)
        : await host.dock(address.tabId);
    if (changed) return;

    const snapshot = this.getChatWorkspaceViewSnapshot();
    if (!snapshot) return;
    this.log(`[chat-tabs] failed command=${command} reason=placement_failed`);
    this.postChatTabActionMessage(
      {
        type: "chatTabActionFailed",
        failure: { command, reason: "placement_failed", snapshot },
      },
      address,
    );
  }

  private async handleChatTabAction(
    command: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const address = parseChatTabActionAddress(msg);
    const coordinator = this.chatTabHostCoordinator;
    if (!address || !coordinator) {
      this.rejectChatTabAction(
        command,
        "invalid_address",
        address ?? undefined,
      );
      return;
    }

    const mode = typeof msg.mode === "string" ? msg.mode : "code";
    const projectId =
      typeof msg.projectId === "string" ? msg.projectId : undefined;
    const stopRunning = msg.stopRunning === true;
    const targetSessionId =
      typeof msg.targetSessionId === "string" ? msg.targetSessionId : undefined;
    const tabIds = Array.isArray(msg.tabIds)
      ? msg.tabIds.filter((value): value is string => typeof value === "string")
      : [];

    const result =
      command === "chatTabFocus"
        ? await coordinator.focus(address)
        : command === "chatTabNew"
          ? await coordinator.newTab(address, mode, projectId)
          : command === "chatTabNewChat"
            ? await coordinator.newChat(address, mode, {
                projectId,
                stopRunning,
              })
            : command === "chatTabClose"
              ? await coordinator.close(address, stopRunning)
              : command === "chatTabLoadSession" && targetSessionId
                ? await coordinator.loadSession(address, targetSessionId, {
                    stopRunning,
                  })
                : command === "chatTabReorder" && Array.isArray(msg.tabIds)
                  ? await coordinator.reorder(address, tabIds)
                  : null;

    if (!result) {
      this.rejectChatTabAction(command, "invalid_address", address);
      return;
    }
    if (!result.ok) {
      if (result.reason === "confirmation_required") {
        this.postChatTabActionMessage(
          {
            type: "chatTabActionConfirmationRequested",
            request: {
              command,
              action: result.action,
              address,
              mode,
              projectId,
              targetSessionId: result.targetSessionId,
            },
          },
          address,
        );
        return;
      }
      if (
        command === "chatTabFocus" &&
        result.reason === "session_not_found" &&
        address.sessionId !== null
      ) {
        // The tab's bound session has no readable persisted record (deleted
        // or corrupt on disk). focusTab already switched the visible tab, so
        // leaving the dead binding in place would strand the tab on its
        // placeholder. Unbind it into a usable New Chat tab instead — the
        // same repair the startup restore applies to reload-time ghosts.
        this.log(
          `[chat-tabs] unbinding tab ${address.tabId} from missing session ${address.sessionId}`,
        );
        const rebound = await this.chatTabController?.replaceSession(
          address.tabId,
          address.sessionId,
          null,
        );
        if (rebound?.ok && this.sessionManager) {
          this.foregroundSessionTransition = undefined;
          this.sendChatWorkspaceUpdate();
          this.postMessage({
            type: "stateUpdate",
            state: this.buildChatState(undefined),
          });
          this.postMessage({
            type: "agentSessionUpdate",
            sessions: this.sessionManager.getSessionInfos(),
          });
          await this.sendModelsUpdate();
          await this.sendModesUpdate();
          await this.sendSlashCommands();
          return;
        }
      }
      if (
        result.reason === "stale_controller" ||
        result.reason === "not_found" ||
        result.reason === "stale_session" ||
        result.reason === "invalid_address"
      ) {
        this.rejectChatTabAction(command, result.reason, address);
        return;
      }
      const snapshot = this.getChatWorkspaceViewSnapshot();
      if (!snapshot) return;
      this.log(`[chat-tabs] failed command=${command} reason=${result.reason}`);
      this.postMessage({
        type: "chatTabActionFailed",
        failure: { command, reason: result.reason, snapshot },
      });
      return;
    }

    if (command === "chatTabClose") {
      this.chatTabPanelHost?.releaseTab(address.tabId);
    }
    this.foregroundSessionTransition = undefined;
    // A docked tab can legitimately end up with no session: a reloaded layout
    // may reference a never-persisted session (an empty New Chat at reload
    // time), which the startup restore unbinds. Selecting such a tab must
    // publish the NEW_SESSION composer state — the webview drops session-
    // scoped state addressed to other sessions, so falling back to the
    // foreground session here would leave the tab starved in its "Checking
    // model setup" placeholder forever.
    const focusedTab = this.chatTabController?.getTab(
      this.chatTabController.getFocusedTabId(),
    );
    const focusedTabSessionless = focusedTab?.sessionId === null;
    const selectedSession =
      result.session ??
      (focusedTabSessionless
        ? undefined
        : this.sessionManager?.getForegroundSession());
    // Publish the final tab-to-session binding before any session-scoped state.
    // Otherwise the webview cannot attribute hydration for a newly created tab.
    this.sendChatWorkspaceUpdate();
    if (selectedSession) {
      this.postSessionLoaded(selectedSession, {
        checkpoints: this.getSessionCheckpoints(selectedSession.id),
        tailTurns:
          command === "chatTabNew" || command === "chatTabNewChat"
            ? 0
            : undefined,
        // Focus-style selection changes only re-point the webview at a session
        // it may already hold live/cached state for — mark them so it can
        // serve from cache instead of destructively re-applying.
        origin:
          command === "chatTabFocus" || command === "chatTabClose"
            ? "focus"
            : undefined,
      });
      this.sendInitialState();
    } else if (focusedTabSessionless && this.sessionManager) {
      this.postMessage({
        type: "stateUpdate",
        state: this.buildChatState(undefined),
      });
      this.postMessage({
        type: "agentSessionUpdate",
        sessions: this.sessionManager.getSessionInfos(),
      });
    } else {
      this.sendInitialState();
    }
    // The model catalog is shared across tabs, but a tab action can switch the
    // active projection while the initial asynchronous catalog hydration is
    // still in flight. Re-send it after every successful handoff so the newly
    // selected tab cannot remain indefinitely in its "checking" state.
    await this.sendModelsUpdate();
    await this.sendModesUpdate();
    await this.sendSlashCommands();
  }

  private sendBgSessionsUpdate(): void {
    if (!this.sessionManager) return;
    this.postMessage({
      type: "agentBgSessionsUpdate",
      sessions: this.sessionManager.getBgSessionInfos(),
    });
    this.browserGatewaySurfaceChangeEmitter.fire("background");
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

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.updateBrowserGatewayThemeState(() => {
      this.view = webviewView;
      this.webviewReady = false;
      this.browserGatewayThemeSnapshot = null;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.updateBrowserGatewayThemeState(() => {
        this.view = undefined;
        this.webviewReady = false;
        this.browserGatewayThemeSnapshot = null;
      });
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendInitialState();
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      void this.handleWebviewMessage(msg).catch((error) => {
        const command =
          typeof msg?.command === "string" ? msg.command : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[webview] ${command} failed: ${message}`);
        if (command === "agentSetModel") {
          void vscode.window.showErrorMessage(
            `Could not select the model: ${message}`,
          );
        } else if (command === "agentSend") {
          void vscode.window.showErrorMessage(
            `Could not send the message: ${message}`,
          );
        }
      });
    });
  }

  private async handleWebviewMessage(
    msg: Record<string, unknown>,
    context?: {
      sourceSessionId?: string;
      connection?: ChatPaneConnection;
    },
  ): Promise<void> {
    if (!this.sessionManager) return;
    const explicitSourceSessionId = context?.sourceSessionId;
    const foregroundSession = this.sessionManager.getForegroundSession();
    const sourceSession = explicitSourceSessionId
      ? this.sessionManager.getSession?.(explicitSourceSessionId)
      : foregroundSession;
    const sourceSessionId = explicitSourceSessionId ?? sourceSession?.id;

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
      case "agentRefreshDebugInfo":
        void this.sendDebugInfo(
          typeof msg.sessionId === "string" ? msg.sessionId : undefined,
        );
        break;

      case "webviewReady":
        await this.hydrateReadyWebview();
        break;

      case "chatTabFocus":
      case "chatTabNew":
      case "chatTabNewChat":
      case "chatTabClose":
      case "chatTabLoadSession":
      case "chatTabReorder":
        await this.handleChatTabAction(String(msg.command), msg);
        break;
      case "chatTabPopOut":
      case "chatTabDock":
        await this.handleChatTabPlacementAction(msg.command, msg);
        break;

      case "themeSnapshot": {
        const parsed = this.parseThemeSnapshot(msg);
        if (parsed) {
          this.updateBrowserGatewayThemeState(() => {
            this.browserGatewayThemeSnapshot = parsed;
          });
        }
        break;
      }

      case "agentSend": {
        const text = msg.text as string;
        const hasWorkspaceProjects = this.hasWorkspaceProjects();
        const mode = hasWorkspaceProjects
          ? ((msg.mode as string) ?? "code")
          : "ask";
        // The webview posts sessionId: null for a not-yet-created chat
        // (NEW_SESSION state); treat it like undefined so the in-flight
        // foreground transition is awaited instead of minting a duplicate.
        const sessionId =
          context?.sourceSessionId ??
          ((msg.sessionId ?? undefined) as string | undefined);
        const reasoningEffort = resolveReasoningEffortMessage(
          msg.reasoningEffort,
          msg.thinkingEnabled,
        );
        const thinkingEnabled = reasoningEffort
          ? reasoningEffort !== "none"
          : msg.thinkingEnabled !== false;
        const requestedModel =
          typeof msg.model === "string" && msg.model ? msg.model : undefined;
        const selectedModel = requestedModel
          ? (await this.getBrowserModels()).find(
              (model) => model.id === requestedModel,
            )
          : undefined;
        if (requestedModel && !selectedModel?.authenticated) {
          void vscode.window.showErrorMessage(
            selectedModel
              ? `Set up ${selectedModel.providerDisplayName ?? selectedModel.provider} before sending a message.`
              : "Choose an available model before sending a message.",
          );
          return;
        }
        const rawMessages = Array.isArray(msg.messages)
          ? (msg.messages as Array<Record<string, unknown>>)
          : [
              {
                text,
                displayText: msg.displayText,
                isSlashCommand: msg.isSlashCommand,
                slashCommandLabel: msg.slashCommandLabel,
                attachments: msg.attachments,
                images: msg.images,
                documents: msg.documents,
              },
            ];
        const mgr = this.sessionManager;
        let effectiveSessionId =
          await this.resolveForegroundSessionTransition(sessionId);
        const sessionlessSend = !sessionId;
        if (!effectiveSessionId || !mgr.getSession(effectiveSessionId)) {
          const address = parseChatTabActionAddress(msg);
          let newSession: AgentSession;
          if (address) {
            const result = await this.chatTabHostCoordinator?.newChat(
              address,
              mode,
              { focus: false },
            );
            if (!result?.ok || !result.session) {
              this.rejectChatTabAction("agentSend", "stale_session");
              return;
            }
            newSession = result.session;
            if (this.chatTabController?.getFocusedTabId() === address.tabId) {
              mgr.switchTo(newSession.id);
            }
          } else {
            newSession = await mgr.createSession(mode, {
              activeFilePath:
                vscode.window.activeTextEditor?.document.uri.fsPath,
            });
          }
          effectiveSessionId = newSession.id;
          this.approvalManager?.migrateSessionState(
            "agent",
            effectiveSessionId,
          );
        }
        if (sessionlessSend) {
          const targetRoot =
            mgr.getSession(effectiveSessionId)?.projectScope.rootPath;
          if (typeof msg.model === "string" && msg.model) {
            try {
              await this.submitSessionSetModel(effectiveSessionId, msg.model);
            } catch (error) {
              this.log(
                `[selection] Could not apply pre-session model ${msg.model}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (
            msg.agentWriteApproval === "prompt" ||
            msg.agentWriteApproval === "session" ||
            msg.agentWriteApproval === "project" ||
            msg.agentWriteApproval === "global"
          ) {
            const result = this.setSessionWriteApproval(
              effectiveSessionId,
              msg.agentWriteApproval,
              targetRoot,
            );
            if (result && !result.ok) {
              this.log(
                `[selection] Could not apply pre-session write approval; retained ${result.agentWriteApproval}`,
              );
            }
          }
          if (isCommandApprovalPolicy(msg.commandApprovalPolicy)) {
            const result = this.setSessionCommandApprovalPolicy(
              effectiveSessionId,
              msg.commandApprovalPolicy,
              targetRoot,
            );
            if (result && !result.ok) {
              this.log(
                `[selection] Could not apply pre-session command approval policy; retained ${result.commandApprovalPolicy}`,
              );
            }
          }
        }
        const effectiveSession = mgr.getSession(effectiveSessionId);
        const projectless = effectiveSession
          ? isProjectlessSessionScope(effectiveSession.projectScope)
          : false;
        const projectRoot = this.getSessionProjectRoot(effectiveSessionId);
        if (!projectRoot && !projectless) {
          vscode.window.showErrorMessage(
            "The selected project is unavailable for local attachments.",
          );
          return;
        }
        const sendMessages = await Promise.all(
          rawMessages.map(async (raw) => {
            const messageText = String(raw.text ?? "");
            const attachments = (raw.attachments as string[] | undefined) ?? [];
            const images =
              (raw.images as
                | Array<{ name: string; mimeType: string; base64: string }>
                | undefined) ?? [];
            const documents =
              (raw.documents as
                | Array<{ name: string; mimeType: string; base64: string }>
                | undefined) ?? [];
            if (projectless && attachments.length > 0) {
              throw new Error(
                "Open a folder before attaching local workspace files.",
              );
            }
            const resolved = projectRoot
              ? await this.resolveAttachments(
                  messageText,
                  attachments,
                  projectRoot,
                )
              : { text: messageText, images: [], documents: [] };
            return {
              text: resolved.text,
              displayText: raw.displayText as string | undefined,
              isSlashCommand: raw.isSlashCommand === true,
              slashCommandLabel: raw.slashCommandLabel as string | undefined,
              attachments,
              images: [...images, ...resolved.images],
              documents: [...documents, ...resolved.documents],
            };
          }),
        );
        const nonEmptyMessages = sendMessages.filter(
          (message) =>
            message.text.trim().length > 0 ||
            message.images.length > 0 ||
            message.documents.length > 0,
        );

        if (nonEmptyMessages.length === 0) return;

        if (mgr.getForegroundSession()?.id === effectiveSessionId) {
          for (const message of nonEmptyMessages) {
            this.applyProjectedAction({
              type: "ADD_USER_MESSAGE",
              text: message.displayText ?? message.text,
              isSlashCommand: message.isSlashCommand,
              slashCommandLabel: message.slashCommandLabel,
            });
          }
        }

        this.log(
          `[send] session=${sessionId ?? "new"} mode=${mode} reasoning=${reasoningEffort ?? (thinkingEnabled ? "default" : "none")} messages=${nonEmptyMessages.length} text="${nonEmptyMessages[0]!.text.slice(0, 80)}${nonEmptyMessages[0]!.text.length > 80 ? "..." : ""}"`,
        );
        for (const message of nonEmptyMessages) {
          for (const img of message.images) {
            this.log(
              `[send:image] name="${img.name}" mimeType="${img.mimeType}" base64Length=${img.base64?.length ?? 0}`,
            );
          }
        }

        mgr
          .sendMessage(effectiveSessionId, nonEmptyMessages[0]!.text, mode, {
            thinkingEnabled,
            reasoningEffort,
            activeFilePath: mgr.getSession(effectiveSessionId)?.activeFilePath,
            displayText: nonEmptyMessages[0]!.displayText,
            isSlashCommand: nonEmptyMessages[0]!.isSlashCommand,
            slashCommandLabel: nonEmptyMessages[0]!.slashCommandLabel,
            origin: "vscode",
            images:
              nonEmptyMessages[0]!.images.length > 0
                ? nonEmptyMessages[0]!.images
                : undefined,
            documents:
              nonEmptyMessages[0]!.documents.length > 0
                ? nonEmptyMessages[0]!.documents
                : undefined,
            additionalMessages: nonEmptyMessages.slice(1).map((message) => ({
              text: message.text,
              displayText: message.displayText,
              isSlashCommand: message.isSlashCommand,
              slashCommandLabel: message.slashCommandLabel,
              origin: "vscode",
              images: message.images.length > 0 ? message.images : undefined,
              documents:
                message.documents.length > 0 ? message.documents : undefined,
            })),
          })
          .catch((err) => {
            this.log(`[error] send failed: ${err}`);
          });

        const sentSession = mgr.getSession(effectiveSessionId);
        if (sentSession) {
          this.postMessage({
            type: "stateUpdate",
            state: {
              ...this.buildChatState(sentSession),
              streaming: true,
              interrupted: false,
            },
          });
        }
        break;
      }

      case "agentMemoryQuery": {
        const request =
          (msg.request as Partial<MemoryInspectionQueryRequest> | undefined) ??
          {};
        const scope = request.scope;
        if (scope !== "global" && scope !== "project") break;
        await this.postMemoryPanelSnapshot(
          {
            scope,
            ...(typeof request.query === "string"
              ? { query: request.query.slice(0, 1_000) }
              : {}),
            ...(Array.isArray(request.kinds) ? { kinds: request.kinds } : {}),
            ...(Array.isArray(request.statuses)
              ? { statuses: request.statuses }
              : {}),
            ...(Array.isArray(request.sources)
              ? { sources: request.sources }
              : {}),
            limit:
              typeof request.limit === "number" &&
              Number.isFinite(request.limit)
                ? request.limit
                : 100,
          },
          {
            requestId:
              typeof msg.requestId === "string" ? msg.requestId : undefined,
            open: msg.open === true,
          },
        );
        break;
      }

      case "agentMemoryDetail": {
        const recordId =
          typeof msg.recordId === "string" ? msg.recordId.trim() : "";
        const scope = msg.scope;
        if (
          !recordId ||
          recordId.length > 200 ||
          (scope !== "global" && scope !== "project")
        ) {
          break;
        }
        await this.postMemoryPanelDetail(
          recordId,
          scope,
          typeof msg.requestId === "string" ? msg.requestId : undefined,
        );
        break;
      }

      case "agentMemoryManage": {
        const provider = this.memoryInspectionProvider;
        const input = msg.input as ManageMemoryToolInput | undefined;
        const request = msg.request as
          | Partial<MemoryInspectionQueryRequest>
          | undefined;
        const requestId =
          typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (
          !input ||
          (input.scope !== "global" && input.scope !== "project") ||
          request?.scope !== input.scope
        ) {
          break;
        }
        if (!provider) {
          this.postMemoryPanelMutationError(input.scope, requestId);
          break;
        }
        try {
          const context = this.getMemoryPanelContext(input.scope);
          const result = await provider.manageAsUser(input, {
            projectId: context.projectId,
            observedAt: new Date().toISOString(),
            evidence: input.source_evidence,
          });
          await this.refreshContextHealth();
          await this.postMemoryPanelSnapshot(
            { ...request, ...context },
            {
              requestId,
              selectedId: result.result.record?.id ?? input.target_id,
            },
          );
        } catch {
          this.postMemoryPanelMutationError(input.scope, requestId);
        }
        break;
      }

      case "agentMemoryClear": {
        const provider = this.memoryInspectionProvider;
        const scope = msg.scope;
        const request = msg.request as
          | Partial<MemoryInspectionQueryRequest>
          | undefined;
        const requestId =
          typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (
          msg.confirm !== true ||
          (scope !== "global" && scope !== "project") ||
          request?.scope !== scope
        ) {
          break;
        }
        if (!provider) {
          this.postMemoryPanelMutationError(scope, requestId);
          break;
        }
        try {
          const context = this.getMemoryPanelContext(scope);
          await provider.clearScope({
            ...context,
            observedAt: new Date().toISOString(),
            evidence: `VS Code user confirmed clearing ${scope} autonomous memory.`,
          });
          await this.refreshContextHealth();
          await this.postMemoryPanelSnapshot(
            { ...request, ...context },
            { requestId },
          );
        } catch {
          this.postMemoryPanelMutationError(scope, requestId);
        }
        break;
      }

      case "agentMemoryExport": {
        const scope = msg.scope;
        if (scope === "global" || scope === "project") {
          await this.exportMemoryArchive(scope);
        }
        break;
      }

      case "agentMemoryImport": {
        const provider = this.memoryInspectionProvider;
        const scope = msg.scope;
        const request = msg.request as
          | Partial<MemoryInspectionQueryRequest>
          | undefined;
        const requestId =
          typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (
          (scope !== "global" && scope !== "project") ||
          request?.scope !== scope ||
          !msg.archive ||
          typeof msg.archive !== "object"
        ) {
          break;
        }
        if (!provider) {
          this.postMemoryPanelMutationError(scope, requestId);
          break;
        }
        try {
          const context = this.getMemoryPanelContext(scope);
          await provider.importArchive(msg.archive as MemoryArchiveV1, {
            ...context,
            observedAt: new Date().toISOString(),
            evidence: `VS Code user imported an autonomous-memory archive into ${scope} scope.`,
          });
          await this.refreshContextHealth();
          await this.postMemoryPanelSnapshot(
            { ...request, ...context },
            { requestId },
          );
        } catch {
          this.postMemoryPanelMutationError(scope, requestId);
        }
        break;
      }

      case "agentSetReasoningEffort": {
        const effort = msg.effort;
        if (!isCoreReasoningEffort(effort)) break;
        if (explicitSourceSessionId) {
          await this.submitSessionSetReasoningEffort(
            explicitSourceSessionId,
            effort,
          );
        } else {
          await this.submitBrowserSetReasoningEffort(effort);
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

      case "agentResumeSession": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          void (async () => {
            // The resume banner can appear from a provisional tail hydration
            // while the startup restore is still parsing transcripts. Wait
            // for the session to be live before resuming through it.
            if (!this.sessionManager?.getSession(sessionId)) {
              try {
                await this.chatTabStartupRestore;
              } catch {
                // Restore failures are logged by the startup path.
              }
              if (!this.sessionManager?.getSession(sessionId)) {
                await this.sessionManager?.hydratePersistedSession?.(sessionId);
              }
            }
            const resumed =
              await this.sessionManager?.resumeInterruptedSession(sessionId);
            if (!resumed) this.sendInitialState();
          })().catch((err) => {
            this.log(`[error] resume failed: ${err}`);
            this.sendInitialState();
          });
        }
        break;
      }

      case "revealToolCallTerminal": {
        const id = msg.id as string | undefined;
        if (id) {
          this.toolCallTracker?.revealTerminal(id);
        }
        break;
      }

      case "cancelToolCall": {
        const id = msg.id as string | undefined;
        if (id) {
          void vscode.commands.executeCommand("agentlink.cancelToolCall", id);
        }
        break;
      }

      case "completeToolCall": {
        const id = msg.id as string | undefined;
        if (id) {
          void vscode.commands.executeCommand("agentlink.completeToolCall", id);
        }
        break;
      }

      case "continueToolCallInBackground": {
        const id = msg.id as string | undefined;
        if (id) {
          void vscode.commands.executeCommand(
            "agentlink.continueToolCallInBackground",
            id,
          );
        }
        break;
      }

      case "agentSteerQueuedMessage": {
        await this.steerQueuedMessageFromUi({
          sessionId: msg.sessionId as string,
          queueId: msg.queueId as string,
          text: msg.text as string,
          displayText: msg.displayText as string | undefined,
          isSlashCommand: msg.isSlashCommand === true,
          slashCommandLabel: msg.slashCommandLabel as string | undefined,
          attachments: (msg.attachments as string[] | undefined) ?? [],
          source: msg.source as "vscode" | "browser" | undefined,
          images:
            (msg.images as
              | Array<{ name: string; mimeType: string; base64: string }>
              | undefined) ?? [],
          documents:
            (msg.documents as
              | Array<{ name: string; mimeType: string; base64: string }>
              | undefined) ?? [],
        });
        break;
      }

      case "agentInterjectQueuedMessage": {
        const accepted = this.interjectQueuedMessageFromUi({
          sessionId: msg.sessionId as string,
          queueId: msg.queueId as string,
          text: msg.text as string,
          displayText: msg.displayText as string | undefined,
          isSlashCommand: msg.isSlashCommand === true,
          slashCommandLabel: msg.slashCommandLabel as string | undefined,
          attachments: (msg.attachments as string[] | undefined) ?? [],
          images:
            (msg.images as
              | Array<{ name: string; mimeType: string; base64: string }>
              | undefined) ?? [],
          documents:
            (msg.documents as
              | Array<{ name: string; mimeType: string; base64: string }>
              | undefined) ?? [],
        });
        if (!accepted) {
          this.postMessage({
            type: "agentQueueInterjectionReady",
            sessionId: msg.sessionId as string,
            queueId: msg.queueId as string,
            ready: false,
          });
          vscode.window.showInformationMessage(
            "The agent is no longer running — the message stays queued and is sent when you submit next.",
          );
        }
        break;
      }

      case "agentPauseQueuedMessageInterjection": {
        this.pauseQueuedMessageInterjectionFromUi(
          msg.sessionId as string,
          msg.queueId as string,
        );
        break;
      }

      case "agentQueuedMessageCount": {
        // The webview reports its local (non-browser) send-queue size so
        // queued messages can take priority over the todo auto-continue.
        const sessionId = msg.sessionId as string;
        const count = msg.count;
        if (sessionId && typeof count === "number" && this.sessionManager) {
          this.sessionManager
            .getSession(sessionId)
            ?.setQueuedUiMessageCount("vscode", count);
        }
        break;
      }

      case "agentRetry": {
        const sessionId = context?.sourceSessionId ?? (msg.sessionId as string);
        if (sessionId && this.submitBrowserRetry(sessionId).ok) {
          const retrySession = this.sessionManager.getSession(sessionId);
          if (retrySession) {
            this.postMessage({
              type: "stateUpdate",
              state: {
                ...this.buildChatState(retrySession),
                streaming: true,
              },
            });
          }
        }
        break;
      }

      case "agentNewSession": {
        const mode = (msg.mode as string) ?? "code";
        const projectId =
          typeof msg.projectId === "string" ? msg.projectId : undefined;
        const transition = this.beginForegroundSessionTransition(mode, {
          projectId,
        });
        transition.promise
          .then((session) => {
            if (this.foregroundSessionTransition !== transition) return;
            this.postSessionLoaded(session, {
              checkpoints: this.getSessionCheckpoints(session.id),
              tailTurns: 0,
            });
            this.sendInitialState();
            this.log(
              `New session created: ${session.id} (model: ${session.model})`,
            );
          })
          .catch((err) => {
            this.log(`[session] failed to create new session: ${err}`);
            vscode.window.showErrorMessage(
              `Failed to create a new AgentLink session: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        break;
      }

      case "agentSwitchMode": {
        const mode = (msg.mode as string) ?? "code";
        if (sourceSession && sourceSession.mode !== mode) {
          const previousMode = sourceSession.mode;
          this.withAsyncApprovalStateTransition(async () => {
            const switched = await this.sessionManager!.switchSessionMode(
              sourceSession.id,
              mode,
              { initialArchitectReviewApproved: true },
            );
            if (!switched) return;
            if (previousMode !== switched.mode) {
              this.recordSurfaceChange(switched, {
                mode: { previousMode, mode: switched.mode },
              });
            }
            this.reconcileSessionApprovalAfterModeSwitch(switched.id);
            this.postMessage({
              type: "stateUpdate",
              state: this.buildChatState(switched),
            });
            if (context?.connection) {
              context.connection.postMessage({
                type: "agentModesUpdate",
                modes: await this.getModesForSession(switched),
              });
              context.connection.postMessage({
                type: "agentSlashCommandsUpdate",
                commands: await this.getSlashCommandsForSession(switched),
              });
            } else {
              await this.sendModesUpdate();
              await this.sendSlashCommands();
            }
            this.log(`[mode] user switched session ${switched.id} to ${mode}`);
          }).catch((err) => {
            this.log(`[mode] failed to switch mode: ${err}`);
          });
        } else if (!sourceSession && !context?.sourceSessionId) {
          // No session yet — preserve the legacy sidebar creation path.
          this.sessionManager.createSession(mode).then(async () => {
            this.sendInitialState();
            await this.sendModesUpdate();
            await this.sendSlashCommands();
            this.log(`[mode] new session created in mode ${mode}`);
          });
        }
        break;
      }

      case "agentClearSession": {
        // Create a fresh session with the same mode as the current one.
        const fg = this.sessionManager.getForegroundSession();
        const mode = fg?.mode ?? "code";
        this.sessionManager.createForegroundSession(mode).then((session) => {
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
        if (explicitSourceSessionId) {
          await this.submitSessionSetModel(explicitSourceSessionId, model);
        } else {
          await this.submitBrowserSetModel(model);
        }
        break;
      }

      case "agentSetCondenseThreshold": {
        const threshold = Number(msg.threshold);
        if (!Number.isFinite(threshold) || !sourceSession) break;
        const { config, target } = this.getPreferenceConfigurationTarget(
          sourceSession.projectScope,
        );
        const currentModel = sourceSession.model;
        const thresholds = {
          ...(config.get("modelCondenseThresholds") as
            | Record<string, number>
            | undefined),
          [currentModel]: Math.min(1, Math.max(0.1, threshold)),
        };
        await config.update("modelCondenseThresholds", thresholds, target);
        sourceSession.autoCondenseThreshold = thresholds[currentModel];
        if (
          this.sessionManager.getForegroundSession()?.id === sourceSession.id
        ) {
          this.sessionManager.updateConfig({
            autoCondenseThreshold: thresholds[currentModel],
          });
        }
        await this.sessionManager.maybeAutoCondenseSession(sourceSession.id);
        this.sessionManager.saveSession(sourceSession.id);
        this.postMessage({
          type: "stateUpdate",
          state: this.buildChatState(sourceSession),
        });
        this.log(
          `Auto-condense threshold set to ${Math.round(thresholds[currentModel] * 100)}% for ${currentModel}`,
        );
        break;
      }

      case "agentSetCommandApprovalPolicy": {
        if (!sourceSession || !isCommandApprovalPolicy(msg.policy)) break;
        this.setSessionCommandApprovalPolicy(
          sourceSession.id,
          msg.policy,
          sourceSession.projectScope.rootPath,
        );
        this.postMessage({
          type: "stateUpdate",
          state: this.buildChatState(sourceSession),
        });
        break;
      }

      case "agentSetWriteApproval": {
        const mode = msg.mode as string;
        if (
          !this.approvalManager ||
          (mode !== "prompt" &&
            mode !== "session" &&
            mode !== "project" &&
            mode !== "global")
        ) {
          break;
        }
        if (!sourceSession) break;
        const result = this.setSessionWriteApproval(
          sourceSession.id,
          mode,
          sourceSession.projectScope.rootPath,
        );
        if (result?.ok) {
          this.postMessage({
            type: "stateUpdate",
            state: this.buildChatState(sourceSession),
          });
          this.log(`Agent write approval changed to: ${mode}`);
        } else {
          this.log(`Agent write approval change failed for: ${mode}`);
          void vscode.window.showErrorMessage(
            "Could not update the write approval setting. The existing approval was preserved where possible.",
          );
        }
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

        const mutationTarget = msg.mutationTarget as
          | McpApprovalPromotionMeta["mutationTarget"]
          | undefined;
        const runtimeServerName =
          mutationTarget?.kind === "agent-plugin-overlay"
            ? mutationTarget.runtimeServerName
            : serverName;
        const toolName = `${runtimeServerName}__${bareToolName}`;
        this.approvalManager.approveMcpTool(sessionId, toolName);

        if (scope === "project" || scope === "global") {
          const projectScope =
            this.sessionManager?.getSession(sessionId)?.projectScope;
          const cwd =
            projectScope?.rootPath ?? this.getSessionProjectRoot(sessionId);
          if (!cwd || !projectScope) {
            vscode.window.showErrorMessage(
              "Unable to persist MCP approval: no workspace or cwd available.",
            );
            break;
          }
          try {
            if (mutationTarget?.kind === "agent-plugin-overlay") {
              if (!this.mcpPolicyMutationProvider) {
                throw new Error("Agent Plugin policy mutation is unavailable.");
              }
              await this.mcpPolicyMutationProvider.persistToolApproval({
                provenance: {
                  kind: "agent-plugin",
                  scope:
                    mutationTarget.scope === "global"
                      ? { kind: "global" }
                      : {
                          kind: "project",
                          projectId: mutationTarget.projectId,
                        },
                  installInstanceId: mutationTarget.installInstanceId,
                  packageDigest: mutationTarget.packageDigest,
                  portableServerName: mutationTarget.declaredServerName,
                  runtimeServerName: mutationTarget.runtimeServerName,
                },
                bareToolName,
                scope,
                requestingScope: projectScope,
              });
            } else {
              const configPaths = getMcpConfigFilePaths(cwd);
              await persistMcpToolApproval(
                serverName,
                bareToolName,
                scope === "project" ? configPaths.project : configPaths.global,
              );
            }
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

      case "agentPluginManagerRefresh":
      case "agentPluginManagerSelectProject": {
        await this.openAgentPluginManager(
          typeof msg.projectId === "string" ? msg.projectId : undefined,
        );
        break;
      }

      case "agentPluginManagerInstall": {
        const projectScope = this.resolveMcpProjectScope(
          typeof msg.projectId === "string" ? msg.projectId : undefined,
        );
        const source = typeof msg.source === "string" ? msg.source.trim() : "";
        if (!source) break;
        await this.handlePluginSlashCommand(`install ${source}`, projectScope);
        await this.openAgentPluginManager(projectScope?.projectId);
        break;
      }

      case "agentPluginManagerAction": {
        const projectScope = this.resolveMcpProjectScope(
          typeof msg.projectId === "string" ? msg.projectId : undefined,
        );
        await this.handleAgentPluginManagerAction({
          action: msg.action as AgentPluginManagerAction,
          installInstanceId:
            typeof msg.installInstanceId === "string"
              ? msg.installInstanceId
              : undefined,
          manifestName:
            typeof msg.manifestName === "string" ? msg.manifestName : undefined,
          projectScope,
        });
        await this.openAgentPluginManager(projectScope?.projectId);
        break;
      }

      case "agentMcpAction": {
        const serverName = msg.serverName as string;
        const action = msg.action as "disable" | "reconnect" | "reauthenticate";
        if (!serverName || !action) break;
        const projectScope = this.resolveMcpProjectScope(
          typeof msg.projectId === "string" ? msg.projectId : undefined,
        );
        if (!projectScope?.rootPath) break;
        const hub = this.getCurrentProjectMcpHub(projectScope) ?? this.mcpHub;
        const runtimeServerName = this.resolveProjectMcpRuntimeServerName(
          hub,
          projectScope.projectId,
          serverName,
        );
        if (!runtimeServerName) break;
        if (action === "disable") {
          const result = await this.persistMcpServerDisabled(
            "main",
            serverName,
            projectScope,
          );
          if (!result.ok) {
            vscode.window.showErrorMessage(
              `Failed to disable MCP server: ${result.errors[0]?.message ?? "unknown error"}`,
            );
          }
        } else if (action === "reconnect") {
          await hub.reconnectServer(runtimeServerName);
        } else if (action === "reauthenticate") {
          await hub.reauthenticateServer(runtimeServerName);
        }
        await this.postMcpManagerSnapshot({
          profile: "main",
          projectScope,
          mainHub: hub,
        });
        break;
      }

      case "agentMcpConfigMutate": {
        const result = await this.submitMcpConfigMutation(
          msg.mutation as McpConfigBatchMutation,
          { allowMainProfileMutation: true },
        );
        this.postMessage({
          type: "agentMcpConfigMutationResult",
          result,
        } as ExtensionToWebview);
        if (result.configSnapshot) {
          this.postMessage({
            type: "agentMcpStatus",
            infos: result.configSnapshot.statusInfos,
            open: true,
            view: "config",
            configSnapshot: result.configSnapshot,
          } as ExtensionToWebview);
        }
        break;
      }

      case "agentMcpConfigSave": {
        const result = await this.submitBrowserMcpConfigServer({
          profile: (msg.profile as McpManagerProfile) ?? "main",
          scope: msg.scope as McpManagerScope,
          projectId:
            typeof msg.projectId === "string" ? msg.projectId : undefined,
          server: msg.server as McpManagerServerDraft,
          allowMainProfileMutation: true,
        });
        if (!result.ok) {
          vscode.window.showErrorMessage(
            `Failed to save MCP server: ${result.errors[0]?.message ?? "unknown error"}`,
          );
        } else if (result.configSnapshot) {
          this.postMessage({
            type: "agentMcpStatus",
            infos: result.configSnapshot.statusInfos,
            open: true,
            view: "config",
            configSnapshot: result.configSnapshot,
          } as ExtensionToWebview);
        }
        break;
      }

      case "agentMcpConfigRemove": {
        const result = await this.submitBrowserMcpConfigRemove({
          profile: (msg.profile as McpManagerProfile) ?? "main",
          scope: msg.scope as McpManagerScope,
          projectId:
            typeof msg.projectId === "string" ? msg.projectId : undefined,
          serverName: String(msg.serverName ?? ""),
          allowMainProfileMutation: true,
        });
        if (!result.ok) {
          vscode.window.showErrorMessage(
            `Failed to remove MCP server: ${result.errors[0]?.message ?? "unknown error"}`,
          );
        } else if (result.configSnapshot) {
          this.postMessage({
            type: "agentMcpStatus",
            infos: result.configSnapshot.statusInfos,
            open: true,
            view: "config",
            configSnapshot: result.configSnapshot,
          } as ExtensionToWebview);
        }
        break;
      }

      case "agentMcpConfigOpenRaw": {
        await this.openRawMcpConfig(
          (msg.profile as McpManagerProfile) ?? "main",
          msg.scope as McpManagerScope,
          (msg.profile ?? "main") === "main"
            ? this.resolveMcpProjectScope(
                typeof msg.projectId === "string" ? msg.projectId : undefined,
              )
            : undefined,
        );
        break;
      }

      case "agentMcpSelectProject": {
        const projectScope = this.resolveMcpProjectScope(
          typeof msg.projectId === "string" ? msg.projectId : undefined,
        );
        if (!projectScope?.rootPath) break;
        if (msg.refresh === true) {
          await this.refreshMcpConnections(undefined, projectScope);
        }
        await this.postMcpManagerSnapshot({
          profile: "main",
          open: true,
          projectScope,
          mainHub: this.getCurrentProjectMcpHub(projectScope),
        });
        break;
      }

      case "agentFormElicitationResponse": {
        this.submitBrowserFormElicitation({
          id: String(msg.id ?? ""),
          action:
            msg.action === "accept"
              ? "accept"
              : msg.action === "decline"
                ? "decline"
                : "cancel",
          ...(msg.action === "accept" &&
          msg.values &&
          typeof msg.values === "object" &&
          !Array.isArray(msg.values)
            ? { values: msg.values as Record<string, unknown> }
            : {}),
        } as McpFormElicitationResponse);
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

      case "revealPendingDiff": {
        await vscode.commands.executeCommand(
          "agentlink.revealDiff",
          String(msg.id ?? ""),
        );
        break;
      }

      case "approvalDecision": {
        const id = msg.id as string;

        this.submitBrowserApprovalDecision({
          id,
          approvalKind: msg.approvalKind as ApprovalRequest["kind"] | undefined,
          decision: msg.decision as string | undefined,
          editedCommand: msg.editedCommand as string | undefined,
          rejectionReason: msg.rejectionReason as string | undefined,
          rulePattern: msg.rulePattern as string | undefined,
          ruleMode: msg.ruleMode as string | undefined,
          rules: msg.rules as
            | Array<{
                pattern: string;
                mode: string;
                decision?: "allow" | "prompt" | "forbidden";
                scope: string;
              }>
            | undefined,
          trustScope: msg.trustScope as string | undefined,
          editedContent: msg.editedContent as string | undefined,
          memoryTier: msg.memoryTier as
            | import("@agentlink/protocol/inline-approval").MemoryTier
            | undefined,
          memoryScope: msg.memoryScope as
            | import("@agentlink/protocol/inline-approval").MemoryScope
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
          sessionId: sourceSessionId,
          connection: context?.connection,
        });
        break;
      }

      case "agentPolishPrompt": {
        const requestId = String(msg.requestId ?? "");
        const draft = String(msg.draft ?? "");
        if (!requestId || !draft.trim()) break;
        void this.handlePolishPrompt({
          requestId,
          draft,
          sessionId: sourceSessionId,
          connection: context?.connection,
        });
        break;
      }

      case "agentQuestionResponse": {
        void this.submitBrowserQuestionResponse({
          id: msg.id as string,
          answers: msg.answers as Record<
            string,
            string | string[] | number | boolean | undefined
          >,
          notes: (msg.notes as Record<string, string>) ?? {},
          attachments:
            msg.attachments as import("@agentlink/protocol/structured-question").UserQuestionResponse["attachments"],
          sessionId: sourceSessionId,
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
        const selection = this.getCustomizationSelection(sourceSession);
        if (selection) {
          this.projectCustomizationRegistry.invalidate(
            selection.scope.projectId,
          );
        }
        await this.refreshSkillConfiguration(selection?.scope.projectId);
        const commands = await this.getCurrentSlashCommands(
          this.getCustomizationSelection(sourceSession),
        );
        if (context?.connection) {
          context.connection.postMessage({
            type: "agentSlashCommandsUpdate",
            commands,
          });
        } else {
          await this.sendSlashCommands();
        }
        this.log(`[slash] refreshed: ${commands.length} commands`);
        break;
      }

      case "agentHandoffConfirm": {
        const draftId = typeof msg.draftId === "string" ? msg.draftId : "";
        const markdown = typeof msg.markdown === "string" ? msg.markdown : "";
        if (!draftId || !markdown) break;
        const result = await this.sessionManager.confirmSessionHandoff(
          draftId,
          markdown,
        );
        const response = result.ok
          ? {
              type: "agentHandoffResult" as const,
              ok: true,
              successorSessionId: result.successorSessionId,
            }
          : {
              type: "agentHandoffResult" as const,
              ok: false,
              error: result.message,
            };
        if (context?.connection) context.connection.postMessage(response);
        else this.postMessage(response);
        break;
      }

      case "agentHandoffCancel": {
        const draftId = typeof msg.draftId === "string" ? msg.draftId : "";
        if (draftId) this.sessionManager.cancelSessionHandoff(draftId);
        break;
      }

      case "agentSlashCommand": {
        const name = msg.name as string;
        if (name === "condense") {
          if (!sourceSession) break;
          await this.sessionManager.condenseSessionById(sourceSession.id);
          // Manual condense doesn't go through run() — emit agentDone so the
          // webview drains any messages queued during the condense operation.
          this.postMessage({
            type: "agentDone",
            sessionId: sourceSession.id,
            transcriptRevision: sourceSession.transcriptRevision,
            totalInputTokens: sourceSession.totalInputTokens,
            totalOutputTokens: sourceSession.totalOutputTokens,
            totalCacheReadTokens: sourceSession.totalCacheReadTokens,
            totalCacheCreationTokens: sourceSession.totalCacheCreationTokens,
          });
          this.drainBrowserQueuedMessage(sourceSession.id);
        } else if (name === "handoff") {
          const result = await this.sessionManager.prepareSessionHandoff(
            sourceSession?.id,
          );
          if (!result.ok) {
            const message = {
              type: "agentHandoffResult",
              ok: false,
              error: result.message,
            } as const;
            if (context?.connection) context.connection.postMessage(message);
            else this.postMessage(message);
            break;
          }
          const message = {
            type: "agentHandoffDraft",
            draft: result.draft,
          } as const;
          if (context?.connection) context.connection.postMessage(message);
          else this.postMessage(message);
        } else if (name === "context-doctor") {
          const result = this.runContextDoctor(sourceSession?.id);
          if (!result.ok) {
            vscode.window.showInformationMessage(
              result.error === "session_busy"
                ? "Context Doctor is unavailable while the session is running."
                : result.error === "workspace_session_required"
                  ? "Context Doctor requires a workspace session."
                  : "No active workspace session is available for Context Doctor.",
            );
          }
        } else if (name === "checkpoint") {
          if (!sourceSession) break;
          const checkpoint =
            await this.sessionManager.createManualCheckpointForSession(
              sourceSession.id,
            );
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
          if (!sourceSession) break;
          const checkpoints = this.sessionManager.getCheckpoints(
            sourceSession.id,
          );
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

          await this.revertCheckpointWithConfirmation(
            sourceSession.id,
            checkpoint.id,
          );
        } else if (name === "workspace") {
          this.showWorkspaceHistory();
        } else if (name === "skills") {
          const selection = this.getCustomizationSelection(sourceSession);
          const skills = selection
            ? await this.projectCustomizationRegistry.getSkillCommands(
                selection.scope,
                selection.mode,
              )
            : [];
          const lines = [
            `Detected skills for mode "${sourceSession?.mode ?? "code"}": ${skills.length}`,
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
        } else if (name === "memory") {
          await this.postMemoryPanelSnapshot(
            { scope: "global", limit: 100 },
            { open: true },
          );
        } else if (name === "plugins") {
          await this.openAgentPluginManager(
            sourceSession?.projectScope.projectId,
          );
        } else if (name === "plugin") {
          await this.handlePluginSlashCommand(
            String(msg.args ?? ""),
            sourceSession?.projectScope,
          );
        } else if (name === "mcp") {
          const projectScope = sourceSession?.projectScope;
          await this.postMcpManagerSnapshot({
            profile: "main",
            open: true,
            projectScope,
            mainHub: this.getCurrentProjectMcpHub(projectScope),
          });
        } else if (name === "mcp-config") {
          const args = String(msg.args ?? "")
            .trim()
            .toLowerCase();
          if (args === "global" || args === "raw global") {
            await this.openMcpConfig("global", sourceSession?.projectScope);
          } else if (args === "project" || args === "raw project") {
            await this.openMcpConfig("project", sourceSession?.projectScope);
          } else if (args === "ask-agent" || args === "raw ask-agent") {
            await this.openRawMcpConfig("ask-agent", "ask-agent-global");
          } else {
            await this.postMcpManagerSnapshot({
              profile: "main",
              open: true,
              view: "config",
              projectScope: sourceSession?.projectScope,
              mainHub: this.getCurrentProjectMcpHub(
                sourceSession?.projectScope,
              ),
            });
          }
        } else if (name === "mcp-refresh") {
          const projectScope = sourceSession?.projectScope;
          await this.refreshAllWorkspaceMcpConnections();
          await this.postMcpManagerSnapshot({
            profile: "main",
            projectScope,
            mainHub: this.getCurrentProjectMcpHub(projectScope),
          });
          vscode.window.showInformationMessage("MCP servers reconnected.");
        } else if (name === "btw") {
          const question = String(msg.args ?? "").trim();
          if (question && sourceSessionId) {
            void this.handleBtwQuestion(question, sourceSessionId);
          }
        } else if (name === "worktree" || name === "review") {
          if (sourceSessionId) {
            void this.handleWorktreeSlashCommand(
              String(msg.args ?? ""),
              sourceSessionId,
              name,
            );
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
        } else if (name === "usage") {
          const data = await queryProviderUsage();
          this.postMessage({ type: "agentProviderUsage", data });
        } else {
          this.log(`[slash] /${name} not yet implemented`);
          vscode.window.showInformationMessage(
            `Unknown slash command: /${name}`,
          );
        }
        break;
      }

      case "agentBtwCancel": {
        const requestId = String(msg.requestId ?? "");
        if (requestId && sourceSessionId) {
          this.cancelBtwQuestion(requestId, sourceSessionId);
        }
        break;
      }

      case "agentWorktreeSetupCancel": {
        const requestId = String(msg.requestId ?? "");
        const setup = this.pendingWorktreeSetups.get(requestId);
        if (setup?.sessionId === sourceSessionId) {
          this.cancelWorktreeSetup(requestId);
        }
        break;
      }

      case "agentWorktreeSetupReply": {
        const requestId = String(msg.requestId ?? "");
        const setup = this.pendingWorktreeSetups.get(requestId);
        const text = String(msg.text ?? "").trim();
        if (
          !setup ||
          setup.sessionId !== sourceSessionId ||
          setup.running ||
          !text
        )
          break;
        setup.conversation.push({ role: "user", text });
        setup.controller = new AbortController();
        void this.runWorktreeSetupTurn(requestId);
        break;
      }

      case "agentWorktreeSetupLaunch": {
        const requestId = String(msg.requestId ?? "");
        const autoSubmit = msg.autoSubmit !== false;
        const setup = this.pendingWorktreeSetups.get(requestId);
        if (setup?.sessionId === sourceSessionId) {
          void this.launchConfiguredWorktree(requestId, autoSubmit);
        }
        break;
      }

      case "agentBtwPromote": {
        const question = String(msg.question ?? "");
        const answer = String(msg.answer ?? "");
        if (question && answer) {
          await this.promoteBtwAnswer(question, answer, sourceSessionId);
        }
        break;
      }

      case "agentOpenImageInEditor": {
        const src = typeof msg.src === "string" ? msg.src : "";
        const name = typeof msg.name === "string" ? msg.name : undefined;
        const mimeType =
          typeof msg.mimeType === "string" ? msg.mimeType : undefined;
        try {
          await this.openImageInEditor({ src, name, mimeType });
        } catch (err) {
          this.log(`[open-image] Failed to open image: ${err}`);
          void vscode.window.showErrorMessage(
            "AgentLink could not open this image in the editor.",
          );
        }
        break;
      }

      case "agentOpenFile": {
        const filePath = typeof msg.path === "string" ? msg.path.trim() : "";
        const line = typeof msg.line === "number" ? msg.line : undefined;
        const requestId =
          typeof msg.requestId === "string" ? msg.requestId : undefined;
        const reply = (ok: boolean, error?: "not_found" | "open_failed") => {
          if (!requestId) return;
          const message: ExtensionToWebview = {
            type: "agentOpenFileResult",
            requestId,
            ok,
            error,
          };
          if (context?.connection) context.connection.postMessage(message);
          else this.postMessage(message);
        };
        if (!filePath) {
          reply(false, "not_found");
          break;
        }
        const projectRoot =
          sourceSession?.projectScope.rootPath ??
          (sourceSessionId
            ? this.getSessionProjectRoot(sourceSessionId)
            : this.getCurrentProjectScope()?.rootPath);
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : projectRoot
            ? path.resolve(projectRoot, filePath)
            : undefined;
        if (!absolutePath) {
          reply(false, "not_found");
          break;
        }
        try {
          await this.revealPathInEditor(absolutePath, line);
          reply(true);
        } catch (err) {
          this.log(`[open-file] Failed to open ${absolutePath}: ${err}`);
          const notFound =
            (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
          reply(false, notFound ? "not_found" : "open_failed");
        }
        break;
      }

      case "openBgTranscript": {
        const sessionId = msg.sessionId as string;
        if (sessionId) {
          const session = this.sessionManager?.getSession(sessionId);
          const messages =
            this.sessionManager?.getBackgroundTranscriptMessages(sessionId);
          if (session && messages) {
            this.postMessage({
              type: "showBgTranscript",
              sessionId,
              task: session.title ?? "Background Agent",
              messages: stripMediaForTransport(messages),
              todos: getLatestTodoState(messages),
            });
          } else {
            vscode.window.showWarningMessage(
              "Background agent session not found — it may have been cleaned up.",
            );
          }
        }
        break;
      }

      case "steerBgAgent": {
        if (sourceSessionId && typeof msg.sessionId === "string") {
          this.sessionManager?.steerAuthorizedBackground(
            sourceSessionId,
            msg.sessionId,
            String(msg.message ?? ""),
          );
        }
        break;
      }

      case "detachBgAgent": {
        if (sourceSessionId && typeof msg.sessionId === "string") {
          this.sessionManager?.detachAuthorizedBackground(
            sourceSessionId,
            msg.sessionId,
          );
        }
        break;
      }

      case "retryBgAgent": {
        if (typeof msg.sessionId === "string") {
          void this.sessionManager?.retryBackground(msg.sessionId);
        }
        break;
      }

      case "archiveBgAgent": {
        if (typeof msg.sessionId === "string") {
          this.sessionManager?.archiveBackground(msg.sessionId);
        }
        break;
      }

      case "pauseBgAgent": {
        if (typeof msg.sessionId === "string") {
          this.sessionManager?.pauseBackground(msg.sessionId);
        }
        break;
      }

      case "resumeBgAgent": {
        if (typeof msg.sessionId === "string") {
          void this.sessionManager?.resumeBackground(msg.sessionId);
        }
        break;
      }

      case "markBgEventsRead": {
        if (typeof msg.sessionId === "string") {
          this.sessionManager?.markFleetEventsRead(msg.sessionId);
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

      case "agentResolveAttachmentPreviews": {
        const paths = Array.isArray(msg.paths)
          ? msg.paths.filter((item): item is string => typeof item === "string")
          : [];
        if (paths.length === 0) break;
        const projectRoot =
          sourceSession?.projectScope.rootPath ??
          (sourceSessionId
            ? this.getSessionProjectRoot(sourceSessionId)
            : this.getCurrentProjectScope()?.rootPath);
        const images = projectRoot
          ? await resolveProjectImagePreviews(paths, projectRoot)
          : [];
        this.postMessage({
          type: "agentAttachmentPreviewsResolved",
          images,
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
        this.sendSessionList();
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
        this.foregroundSessionTransition = undefined;
        this.postSessionLoaded(session, {
          checkpoints: this.getSessionCheckpoints(session.id),
        });
        this.sendInitialState();
        break;
      }

      case "agentLoadEarlierSessionMessages": {
        const sessionId = context?.sourceSessionId ?? (msg.sessionId as string);
        const beforeUserTurnOffset = Number(msg.beforeUserTurnOffset);
        if (
          !sessionId ||
          !Number.isInteger(beforeUserTurnOffset) ||
          beforeUserTurnOffset <= 0
        ) {
          break;
        }
        const session = this.sessionManager.getSession(sessionId);
        if (!session) break;
        const chunk = getPreviousChunkByUserTurns(
          session.getAllMessages(),
          beforeUserTurnOffset,
          RESTORE_BACKFILL_BATCH_TURNS,
        );
        this.postMessage({
          type: "agentSessionChunk",
          sessionId,
          messages: chunk.messages,
          userTurnOffset: chunk.userTurnOffset,
          messageIndexOffset: chunk.messageIndexOffset,
          hasMoreBefore: chunk.hasMoreBefore,
          checkpoints: this.getSessionCheckpoints(sessionId),
        });
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
        this.sendSessionList();
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
        this.sendSessionList();
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
        const method =
          msg.method === "oauth" || msg.method === "apiKey"
            ? msg.method
            : undefined;
        try {
          await vscode.commands.executeCommand(
            "agentlink.codexSignIn",
            method === "oauth"
              ? "oauthOnly"
              : method === "apiKey"
                ? "apiKeyOnly"
                : undefined,
          );
        } finally {
          this.refreshModels();
        }
        break;
      }

      case "agentAnthropicSignIn": {
        try {
          await vscode.commands.executeCommand("agentlink.setAnthropicApiKey");
        } finally {
          this.refreshModels();
        }
        break;
      }

      case "agentOpenAiCompatibleSignIn": {
        const providerId =
          typeof msg.provider === "string" ? msg.provider.trim() : "";
        const authKey = this.openAiCompatibleAuthKeyResolver?.(providerId);
        if (authKey) {
          try {
            await vscode.commands.executeCommand(
              "agentlink.setOpenAiCompatibleApiKey",
              authKey,
            );
          } finally {
            this.refreshModels();
          }
        }
        break;
      }

      case "agentConfigureOpenAiCompatibleModel": {
        try {
          await vscode.commands.executeCommand(
            "agentlink.configureOpenAiCompatibleModel",
          );
        } finally {
          this.refreshModels();
        }
        break;
      }

      case "agentOpenFolder": {
        await vscode.commands.executeCommand("vscode.openFolder");
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

  private get projectedForegroundState(): AppState {
    return this.projectedForegroundStore.state;
  }

  private set projectedForegroundState(state: AppState) {
    this.projectedForegroundStore.replaceState(state);
  }

  private applyProjectedAction(action: Parameters<typeof reducer>[1]): void {
    this.projectedForegroundStore.apply(action);
    if (
      action.type === "ENQUEUE_MESSAGE" ||
      action.type === "REMOVE_FROM_QUEUE" ||
      action.type === "SET_STATE"
    ) {
      this.syncBrowserQueuedMessageCount();
    }
  }

  /**
   * Mirror the projection's browser-sourced queue size onto the foreground
   * session so queued browser messages take priority over auto-continue.
   * (VS Code webview entries are reported separately via
   * "agentQueuedMessageCount" — they never appear in the projection queue.)
   */
  private syncBrowserQueuedMessageCount(): void {
    const fg = this.sessionManager?.getForegroundSession();
    if (!fg) return;
    fg.setQueuedUiMessageCount?.(
      "browser",
      this.projectedForegroundState.messageQueue.filter(
        (entry) => entry.source === "browser",
      ).length,
    );
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
    this.projectedForegroundStore.reset();
    this.projectedDetectRequest = null;
    this.projectedLastDetectKey = null;
    this.detectRequestInputs.clear();
  }

  private syncProjectedControllerEpoch(): void {
    this.projectedForegroundStore.setControllerEpoch(
      this.getChatWorkspaceViewSnapshot()?.controllerEpoch ?? null,
    );
  }

  private ensureProjectedForegroundSession(
    session: AgentSession | undefined,
  ): void {
    if (!session) {
      this.resetProjectedForegroundState();
      return;
    }

    const shouldHydrate =
      this.projectedForegroundStore.sessionId !== session.id;
    if (!shouldHydrate) return;

    const allMessages =
      typeof (session as { getAllMessages?: unknown }).getAllMessages ===
      "function"
        ? session.getAllMessages()
        : [];
    this.projectedForegroundStore.hydrate(
      {
        type: "LOAD_SESSION",
        sessionId: session.id,
        title: session.title,
        mode: session.mode,
        model: session.model,
        messages: agentMessagesToChatMessages(allMessages),
        todos: getLatestTodoState(allMessages),
        lastInputTokens: session.lastInputTokens,
        lastOutputTokens: session.lastOutputTokens,
        checkpoints: this.getSessionCheckpoints(session.id),
        userTurnOffset: 0,
        hasMoreBefore: false,
      },
      session.estimatedTotalUsed,
    );
    this.projectedDetectRequest = null;
    this.projectedLastDetectKey = null;
    this.detectRequestInputs.clear();
  }

  private formatRevertRecoveryNoticeForSession(
    sessionId: string,
  ): RevertRecoveryNotice | null {
    const recovery = this.sessionManager?.getRevertRecoveryState?.(sessionId);
    return recovery ? formatRevertRecoveryNotice(recovery) : null;
  }

  private projectExtensionMessage(msg: ExtensionToWebview): void {
    const fg = this.sessionManager?.getForegroundSession();
    this.syncProjectedControllerEpoch();
    this.ensureProjectedForegroundSession(fg);

    const extMsg = msg as unknown as ExtensionMessage;

    if (extMsg.type === "stateUpdate") {
      if (extMsg.state.sessionId && extMsg.state.sessionId !== fg?.id) return;
      this.projectedForegroundStore.setSessionId(extMsg.state.sessionId);
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
      extMsg.type === "agentBgTodoUpdate" ||
      extMsg.type === "agentBgWarning" ||
      extMsg.type === "agentBgStatusUpdate" ||
      extMsg.type === "agentBgFinalMarker" ||
      extMsg.type === "agentBgCondenseStart" ||
      extMsg.type === "agentBgCondense" ||
      extMsg.type === "agentBgCondenseError" ||
      extMsg.type === "agentBgInterjection" ||
      extMsg.type === "agentBgDone";

    if (
      shouldDropSessionScopedEvent(
        extMsg.type,
        eventSessionId,
        this.projectedForegroundStore.sessionId,
        isBackgroundEvent,
      )
    ) {
      return;
    }

    const dropIfNotStreaming = (): boolean => {
      if (this.projectedForegroundStore.isStreaming) return false;
      const liveFg = this.sessionManager?.getForegroundSession();
      const liveStreaming = Boolean(
        liveFg &&
        (liveFg.status === "streaming" ||
          liveFg.status === "tool_executing" ||
          liveFg.status === "awaiting_approval"),
      );
      if (liveStreaming) {
        this.projectedForegroundStore.setStreaming(true);
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
          parentCallId: extMsg.parentCallId,
          input: extMsg.input,
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
          resultImages: extMsg.resultImages,
          resultDocuments: extMsg.resultDocuments,
          durationMs: extMsg.durationMs,
          input: extMsg.input,
          parentCallId: extMsg.parentCallId,
          mcpApprovalPromotion: extMsg.mcpApprovalPromotion,
          composeTrace: extMsg.composeTrace,
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

      case "agentSurfaceChange":
        this.applyProjectedAction({
          type: "ADD_SURFACE_CHANGE",
          change: extMsg.change,
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
          reasoningEffort: extMsg.reasoningEffort,
          mode: extMsg.mode,
          commandApprovalPolicy: extMsg.commandApprovalPolicy,
          inputTokens: extMsg.inputTokens,
          uncachedInputTokens: extMsg.uncachedInputTokens,
          outputTokens: extMsg.outputTokens,
          cacheReadTokens: extMsg.cacheReadTokens,
          cacheCreationTokens: extMsg.cacheCreationTokens,
          usageEstimated: extMsg.usageEstimated,
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
        if (extMsg.transcriptRevision !== undefined) {
          this.projectedForegroundStore.recordTranscriptRevision(
            extMsg.sessionId,
            extMsg.transcriptRevision,
          );
        }
        this.applyProjectedAction({ type: "DONE" });
        break;

      case "agentInteractionPromptsCleared":
        this.projectedDetectRequest = null;
        this.projectedLastDetectKey = null;
        this.applyProjectedAction({ type: "CLEAR_INTERACTION_PROMPTS" });
        break;

      case "agentDebugInfo":
        if (
          extMsg.sessionId &&
          extMsg.sessionId !== this.projectedForegroundStore.sessionId
        ) {
          break;
        }
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
          toolCallId: extMsg.toolCallId,
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
        if (
          !this.projectedForegroundStore.acceptSessionLoad(
            extMsg.sessionId,
            extMsg.transcriptRevision,
          )
        ) {
          break;
        }
        this.projectedForegroundStore.beginSessionLoad(
          extMsg.sessionId,
          extMsg.hasMoreBefore,
        );
        this.applyProjectedAction({
          type: "LOAD_SESSION",
          sessionId: extMsg.sessionId,
          title: extMsg.title,
          mode: extMsg.mode,
          model: extMsg.model,
          messages: agentMessagesToChatMessages(extMsg.messages as unknown[], {
            baseIndex: extMsg.messageIndexOffset,
          }),
          todos: extMsg.todos,
          lastInputTokens: extMsg.lastInputTokens,
          lastOutputTokens: extMsg.lastOutputTokens,
          backgroundResults: extMsg.backgroundResults,
          checkpoints: extMsg.checkpoints,
          userTurnOffset: extMsg.userTurnOffset ?? 0,
          hasMoreBefore: extMsg.hasMoreBefore,
          inFlight: extMsg.inFlight,
          streaming: extMsg.streaming,
          interrupted: extMsg.interrupted,
        });
        break;
      }

      case "agentSessionChunk": {
        if (
          !this.projectedForegroundStore.acceptSessionChunk(
            extMsg.sessionId,
            extMsg.hasMoreBefore,
          )
        ) {
          break;
        }
        this.applyProjectedAction({
          type: "PREPEND_SESSION_CHUNK",
          messages: agentMessagesToChatMessages(extMsg.messages as unknown[], {
            baseIndex: extMsg.messageIndexOffset,
          }),
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

      case "agentQueueInterjectionReady":
        this.applyProjectedAction({
          type: "MARK_QUEUE_INTERJECTION_READY",
          id: extMsg.queueId,
          ready: extMsg.ready,
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
        if (
          !shouldProjectBackgroundCompletion(
            extMsg.parentSessionId,
            this.projectedForegroundStore.sessionId,
          )
        ) {
          break;
        }
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
        if (extMsg.completion) {
          this.applyProjectedAction({
            type: "BG_AGENT_DONE",
            completion: {
              ...extMsg.completion,
              task: extMsg.completion.task || bgTask,
            },
          });
        }
        break;
      }

      default:
        break;
    }

    if (shouldScheduleDetectedQuestion) {
      this.maybeStartProjectedDetectedQuestionRequest();
    }
  }

  public getBrowserProjectedForegroundState(): BrowserForegroundSnapshot | null {
    const fg = this.sessionManager?.getForegroundSession();
    if (!fg) return null;

    this.ensureProjectedForegroundSession(fg);

    return createBrowserForegroundSnapshot(fg.id, {
      ...this.projectedForegroundState,
      chatState: {
        ...this.projectedForegroundState.chatState,
        ...this.getBrowserSessionApprovalMode(),
      },
    });
  }

  public getBrowserMcpStatusInfos(): McpServerInfo[] {
    return this.getMcpHub().getServerInfos();
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
        // Don't log every delta — too noisy. The flusher coalesces and emits
        // the bg/foreground message variant as appropriate.
        this.deltaBufferFlusher.appendThinking(
          sessionId,
          event.thinkingId,
          event.text,
        );
        break;

      case "thinking_end":
        this.log(`[agent] thinking_end id=${event.thinkingId}`);
        // Flush buffered thinking deltas before marking complete so content
        // arrives at the webview before the block is sealed.
        this.deltaBufferFlusher.flushNow();
        this.postMessage({
          type: isBackground ? "agentBgThinkingEnd" : "agentThinkingEnd",
          sessionId,
          thinkingId: event.thinkingId,
        });
        break;

      case "text_delta":
        // Don't log every delta — too noisy. The flusher coalesces and emits
        // the bg/foreground message variant as appropriate.
        this.deltaBufferFlusher.appendText(sessionId, event.text);
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
        this.deltaBufferFlusher.flushNow();
        this.postMessage({
          type: isBackground ? "agentBgToolStart" : "agentToolStart",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          parentCallId: event.parentCallId,
          input: event.input,
        });
        // Keep bg strip in sync when a bg session starts a new tool
        if (isBackground) {
          this.sendBgSessionsUpdate();
        }
        break;

      case "tool_input_delta":
        this.deltaBufferFlusher.appendToolInput(
          sessionId,
          event.toolCallId,
          event.partialJson,
        );
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
          type: isBackground ? "agentBgTodoUpdate" : "agentTodoUpdate",
          sessionId,
          todos: event.todos,
        } as ExtensionToWebview);
        break;

      case "final_marker":
        this.postMessage({
          type: isBackground ? "agentBgFinalMarker" : "agentFinalMarker",
          sessionId,
          marker: event.marker,
        } as ExtensionToWebview);
        break;

      case "tool_result": {
        // Convert tool result content to a string for the webview
        // Flush buffered tool input deltas before marking the tool complete
        // so the webview sees the full input JSON before the result arrives.
        this.deltaBufferFlusher.flushNow();
        const resultText = event.result
          .map((content) =>
            content.type === "text" ? content.text : `[${content.type}]`,
          )
          .join("\n");
        const resultImages = event.result
          .filter(
            (
              content,
            ): content is Extract<
              ToolResult["content"][number],
              { type: "image" }
            > => content.type === "image",
          )
          .map((image) => ({ mimeType: image.mimeType, data: image.data }));
        const resultDocuments = event.result
          .filter(
            (
              content,
            ): content is Extract<
              ToolResult["content"][number],
              { type: "document" }
            > => content.type === "document",
          )
          .map((document) => ({
            name: document.name,
            mimeType: document.mimeType,
            data: document.data,
          }));
        this.log(
          `[agent] tool_result tool=${event.toolName} id=${event.toolCallId} duration=${event.durationMs}ms`,
        );
        this.postMessage({
          type: isBackground ? "agentBgToolComplete" : "agentToolComplete",
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultText,
          ...(resultImages.length ? { resultImages } : {}),
          ...(resultDocuments.length ? { resultDocuments } : {}),
          durationMs: event.durationMs,
          input: event.input,
          parentCallId: event.parentCallId,
          mcpApprovalPromotion: event.mcpApprovalPromotion,
          composeTrace: event.composeTrace,
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
        if (!isBackground && event.toolName === "manage_memory") {
          void this.refreshContextHealth();
        }
        const annotation = getApprovalResultAnnotation(resultText);
        if (annotation) {
          this.postMessage({
            type: "agentUserAnnotation",
            sessionId,
            ...annotation,
          });
        }
        break;
      }

      case "request_context_attribution":
        this.contextJumpTracker?.onRequestContextAttribution(sessionId, {
          requestId: event.requestId,
          requestKind: event.requestKind,
          model: event.model,
          providerId: event.providerId,
          mode: event.mode,
          promptProfile: event.promptProfile,
          background: event.background,
          estimatedInputTokens: event.estimatedInputTokens,
          toolResultAttributions: event.toolResultContextAttributions,
          omittedToolResultAttributions:
            event.omittedToolResultContextAttributions,
          pinnedMemoryTokens: event.pinnedMemoryTokens,
          retrievedMemoryTokens: event.retrievedMemoryTokens,
          contextLedger: event.contextLedger,
        });
        break;

      case "api_request":
        this.log(
          `[agent] api_request model=${event.model} reasoning=${event.reasoningEffort} in=${event.inputTokens} uncachedIn=${event.uncachedInputTokens} out=${event.outputTokens} ` +
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
          reasoningEffort: event.reasoningEffort,
          mode: this.sessionManager?.getSession(sessionId)?.mode,
          commandApprovalPolicy: this.sessionManager?.getCommandApprovalPolicy(
            sessionId,
            this.getConfiguredCommandApprovalPolicy(),
          ),
          inputTokens: event.inputTokens,
          uncachedInputTokens: event.uncachedInputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          usageEstimated: event.usageEstimated,
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
        this.contextJumpTracker?.onApiRequest(sessionId, {
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          contextWindow: providerRegistry
            .tryResolveProvider(event.model)
            ?.getCapabilities(event.model).contextWindow,
          accumulatedEstimatedTokens: event.accumulatedEstimatedTokens,
          accumulatedBySource: event.accumulatedEstimatedTokensBySource,
          toolResultAttributions: event.toolResultContextAttributions,
          omittedToolResultAttributions:
            event.omittedToolResultContextAttributions,
          pinnedMemoryTokens: event.pinnedMemoryTokens,
          retrievedMemoryTokens: event.retrievedMemoryTokens,
          systemPromptTokens: event.contextBreakdown?.prompt.estimatedTokens,
          toolDefinitionTokens: event.contextBreakdown?.tools?.estimatedTokens,
        });
        break;

      case "error": {
        this.deltaBufferFlusher.flushNow();
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
          type: isBackground ? "agentBgCondenseStart" : "agentCondenseStart",
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
          type: isBackground ? "agentBgCondense" : "agentCondense",
          sessionId,
          prevInputTokens: event.prevInputTokens,
          newInputTokens: event.newInputTokens,
          summary: event.summary,
          durationMs: condenseDurationMs,
          validationWarnings: event.validationWarnings,
          metadata: event.metadata,
        });
        {
          const condensedSession = this.sessionManager?.getSession(sessionId);
          if (condensedSession) {
            this.contextJumpTracker?.onCondense(sessionId, {
              model: condensedSession.model,
              prevInputTokens: event.prevInputTokens,
              newInputTokens: event.newInputTokens,
              durationMs: condenseDurationMs,
            });
          }
          // The context bar's budget snapshot (usedInputTokens) is pushed on
          // send/steer/retry but not on condense, so without this refresh the
          // bar keeps showing pre-condense usage until the next user message.
          const fg = this.sessionManager?.getForegroundSession();
          if (!isBackground && fg && fg.id === sessionId) {
            const condenseThreshold = this.getConfiguredCondenseThreshold(
              fg.model,
            );
            this.postMessage({
              type: "stateUpdate",
              state: {
                sessionId: fg.id,
                mode: fg.mode,
                model: fg.model,
                streaming:
                  fg.status === "streaming" ||
                  fg.status === "tool_executing" ||
                  fg.status === "awaiting_approval",
                condenseThreshold,
                contextBudget: this.buildContextBudget(
                  fg,
                  fg.model,
                  condenseThreshold,
                ),
                agentWriteApproval:
                  this.approvalManager?.getAgentWriteApprovalState(fg.id),
                ...this.getBrowserSessionApprovalMode(),
                configuredCommandApprovalPolicy:
                  this.getConfiguredCommandApprovalPolicy(),
              },
            });
          }
        }
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
            type: isBackground ? "agentBgWarning" : "agentWarning",
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
          type: isBackground ? "agentBgStatusUpdate" : "agentStatusUpdate",
          sessionId,
          message: event.message,
        });
        break;

      case "condense_error":
        this.log(
          `[agent] condense_error: ${event.error} (retryable=${event.retryable ?? false}, code=${event.code ?? "none"})`,
        );
        this.postMessage({
          type: isBackground ? "agentBgCondenseError" : "agentCondenseError",
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
          type: isBackground ? "agentBgInterjection" : "agentInterjection",
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
        this.deltaBufferFlusher.flushNow();
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
        const parentSessionId = isBackground
          ? this.sessionManager?.getBackgroundParentSessionId(sessionId)
          : undefined;
        const backgroundCompletion = isBackground
          ? this.sessionManager?.getBackgroundCompletion(sessionId)
          : undefined;
        const completedSession = this.sessionManager?.getSession(sessionId);
        this.postMessage({
          type: isBackground ? "agentBgDone" : "agentDone",
          sessionId,
          ...(!isBackground && {
            transcriptRevision: completedSession?.transcriptRevision,
          }),
          ...(isBackground && {
            parentSessionId: parentSessionId ?? null,
          }),
          totalInputTokens: event.totalInputTokens,
          totalOutputTokens: event.totalOutputTokens,
          totalCacheReadTokens: event.totalCacheReadTokens,
          totalCacheCreationTokens: event.totalCacheCreationTokens,
          ...(isBackground && {
            completion: backgroundCompletion
              ? {
                  ...backgroundCompletion,
                  summary:
                    backgroundCompletion.summary ??
                    bgInfo?.resultSummary ??
                    this.sessionManager?.getBackgroundResultSummary(sessionId),
                }
              : undefined,
          }),
        });
        if (
          isBackground &&
          shouldProjectBackgroundCompletion(
            parentSessionId ?? null,
            this.sessionManager?.getForegroundSession()?.id ?? null,
          )
        ) {
          this.sessionManager?.markBackgroundResultsAnnounced?.([sessionId]);
        }
        if (!isBackground) {
          this.drainBrowserQueuedMessage(sessionId);
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

  private requireSessionArtifactRoot(sessionId?: string): string {
    const session = sessionId
      ? this.sessionManager?.getSession(sessionId)
      : this.sessionManager?.getForegroundSession();
    if (!session) {
      throw new Error("No agent session is available for artifact export.");
    }

    const scope = session.projectScope;
    if (session.projectAvailability !== "available" || !scope?.rootPath) {
      throw new Error(
        `Project '${scope?.displayName ?? "unknown"}' is unavailable for artifact export.`,
      );
    }

    const projects = this.sessionManager?.getWorkspaceProjects?.();
    if (projects) {
      const project = projects.find(
        (candidate) => candidate.id === scope.projectId,
      );
      if (
        !project ||
        project.availability.status !== "available" ||
        project.uri !== scope.workspaceFolderUri ||
        project.rootPath !== scope.rootPath
      ) {
        throw new Error(
          `Project '${scope.displayName}' is unavailable for artifact export.`,
        );
      }
    }

    return scope.rootPath;
  }

  private async writeCondenseDebug(
    sessionId: string,
    event: {
      prevInputTokens: number;
      newInputTokens: number;
      summary: string;
      validationWarnings?: string[];
      metadata?: CondenseMetadata;
    },
  ): Promise<void> {
    const projectRoot = this.requireSessionArtifactRoot(sessionId);
    const session = this.sessionManager?.getSession(sessionId);
    const { randomUUID: uuid } = require("crypto") as typeof import("crypto");
    const id = uuid().slice(0, 8);
    const dir = path.join(projectRoot, ".agentlink", "debug", "condensing", id);
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
      const metadata = event.metadata;
      summaryLines.push(``);
      summaryLines.push(`## Metadata`);
      summaryLines.push(``);
      if ("providerId" in metadata) {
        summaryLines.push(`- providerId: ${metadata.providerId}`);
        summaryLines.push(`- condenseModel: ${metadata.condenseModel}`);
        summaryLines.push(
          `- modelCandidates: ${metadata.modelCandidates.join(" | ")}`,
        );
        summaryLines.push(`- selectedModel: ${metadata.selectedModel}`);
        summaryLines.push(`- inputMessageCount: ${metadata.inputMessageCount}`);
        summaryLines.push(
          `- sourceUserMessageCount: ${metadata.sourceUserMessageCount}`,
        );
        summaryLines.push(
          `- requestMessageCount: ${metadata.requestMessageCount}`,
        );
        summaryLines.push(
          `- effectiveHistoryMessageCount: ${metadata.effectiveHistoryMessageCount}`,
        );
        summaryLines.push(
          `- effectiveHistoryRoles: ${metadata.effectiveHistoryRoles.join(" | ")}`,
        );
        summaryLines.push(
          `- hadPriorSummaryInInput: ${metadata.hadPriorSummaryInInput}`,
        );
        summaryLines.push(`- sourceHash: ${metadata.sourceHash}`);
      }
      if (metadata.postCondenseProjection) {
        const projection = metadata.postCondenseProjection;
        summaryLines.push(``);
        summaryLines.push(`## Post-Condense Projection`);
        summaryLines.push(``);
        summaryLines.push(
          `- estimatedInputTokens: ${projection.estimatedInputTokens}`,
          `- promptTokens: ${projection.promptTokens}`,
          `- historyTokens: ${projection.historyTokens}`,
          `- modeInstructionTokens: ${projection.modeInstructionTokens}`,
          `- toolTokens: ${projection.toolTokens}`,
          `- nativeToolTokens: ${projection.nativeToolTokens}`,
          `- mcpToolTokens: ${projection.mcpToolTokens}`,
          `- pinnedMemoryTokens: ${projection.pinnedMemoryTokens}`,
          `- retrievedMemoryTokens: ${projection.retrievedMemoryTokens}`,
          `- outputReservationTokens: ${projection.outputReservationTokens}`,
          `- safetyBufferTokens: ${projection.safetyBufferTokens}`,
        );
      }
      if ("providerId" in metadata) {
        summaryLines.push(``);
        summaryLines.push(`## Resume Anchor Inputs`);
        summaryLines.push(``);
        summaryLines.push(`- latestUserMessage: ${metadata.latestUserMessage}`);
        summaryLines.push(`- currentTask: ${metadata.currentTask}`);

        summaryLines.push(``);
        summaryLines.push(`### Pending Tasks`);
        summaryLines.push(``);
        if (metadata.pendingTasks.length > 0) {
          for (const task of metadata.pendingTasks) {
            summaryLines.push(`- ${task}`);
          }
        } else {
          summaryLines.push(`- None`);
        }

        summaryLines.push(``);
        summaryLines.push(`### Canonical User Messages`);
        summaryLines.push(``);
        if (metadata.canonicalUserMessages.length > 0) {
          for (const message of metadata.canonicalUserMessages) {
            summaryLines.push(`- ${message}`);
          }
        } else {
          summaryLines.push(`- None`);
        }
      }
    }
    fs.writeFileSync(
      path.join(dir, "condense-result.md"),
      summaryLines.join("\n"),
      "utf-8",
    );

    // Write full session transcript
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
    let projectRoot: string;
    try {
      projectRoot = this.requireSessionArtifactRoot();
    } catch (error) {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const fs = require("fs");
    const path = require("path");
    const dir = path.join(projectRoot, ".agentlink", "transcripts");
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
  private async handleAgentPluginManagerAction(input: {
    action: AgentPluginManagerAction;
    installInstanceId?: string;
    manifestName?: string;
    projectScope?: Readonly<SessionProjectScope>;
  }): Promise<void> {
    const host = this.agentPluginManagerHost;
    if (!host) return;
    const allowedActions: readonly AgentPluginManagerAction[] = [
      "enable",
      "disable",
      "reinstall",
      "rollback",
      "uninstall",
      "remove-data",
      "install-declared",
    ];
    if (!allowedActions.includes(input.action)) {
      this.log(
        `[plugins] Rejected unknown manager action: ${String(input.action)}`,
      );
      return;
    }
    try {
      if (input.action === "install-declared") {
        if (!input.projectScope || !input.manifestName) {
          throw new Error(
            "Declared plugins require an available owning project.",
          );
        }
        await this.handlePluginSlashCommand(
          `install-declared ${input.manifestName}`,
          input.projectScope,
        );
        return;
      }
      if (!input.installInstanceId) {
        throw new Error("The selected plugin is no longer installed.");
      }
      if (input.action === "enable" || input.action === "disable") {
        await host.setEnabled(
          input.installInstanceId,
          input.action === "enable",
        );
        return;
      }
      if (input.action === "reinstall") {
        await this.handlePluginSlashCommand(
          `reinstall ${input.installInstanceId}`,
          input.projectScope,
        );
        return;
      }
      const labels = {
        rollback: "Rollback",
        uninstall: "Uninstall",
        "remove-data": "Remove Data",
      } as const;
      const label = labels[input.action];
      const consequences =
        input.action === "rollback"
          ? "Swap the current package generation with its previous reviewed generation?"
          : input.action === "uninstall"
            ? "Remove this plugin from the registry? Immutable package bytes remain until a later safe purge. Plugin data is not removed."
            : "Permanently remove this plugin's stored data? The installed plugin and package bytes remain.";
      const confirmed = await vscode.window.showWarningMessage(
        `${consequences}\n\nPlugin: ${input.manifestName ?? input.installInstanceId}`,
        { modal: true },
        label,
      );
      if (confirmed !== label) return;
      if (input.action === "rollback") {
        await host.rollback(input.installInstanceId);
      } else if (input.action === "uninstall") {
        await host.remove(input.installInstanceId);
      } else {
        await host.removeData(input.installInstanceId);
      }
    } catch (error) {
      this.log(`[plugins] Manager action failed: ${String(error)}`);
      void vscode.window.showErrorMessage(
        `Agent Plugin operation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handlePluginSlashCommand(
    rawArgs: string,
    projectScope?: Readonly<SessionProjectScope>,
  ): Promise<void> {
    const host = this.agentPluginManagerHost;
    if (!host) {
      vscode.window.showWarningMessage(
        "Agent Plugins support is unavailable in this AgentLink build.",
      );
      return;
    }
    const trimmedArgs = rawArgs.trim();
    if (!trimmedArgs) {
      await this.openAgentPluginManager(projectScope?.projectId);
      return;
    }
    const parsed = parsePluginCommandArgs(trimmedArgs);
    const action = parsed.action === "add" ? "install" : parsed.action;
    try {
      if (action === "list" || action === "ls") {
        await this.showInstalledAgentPlugins(projectScope);
        return;
      }
      if (action === "install-declared") {
        if (!projectScope?.rootPath || !parsed.operand) {
          throw new Error(
            "Usage: /plugin install-declared <name> from an available project session.",
          );
        }
        const prepared = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Acquiring declared Agent Plugin '${parsed.operand}'…`,
            cancellable: false,
          },
          () => host.prepareDeclaredInstall(projectScope, parsed.operand),
        );
        try {
          const selected = prepared.candidates[0];
          if (!selected) return;
          const enabled = await this.reviewAgentPluginInstall(
            selected,
            prepared.acquired.source.display,
            undefined,
            prepared.target,
            prepared.shareability,
          );
          if (enabled === undefined) return;
          const row = await host.commitPrepared({
            prepared,
            candidate: selected,
            enabled,
          });
          this.showAgentPluginCommitResult(
            row,
            `Installed declared Agent Plugin '${row.manifestName}' ${row.enabled ? "and enabled it" : "disabled"}.`,
          );
        } finally {
          await prepared.acquired.cleanup();
        }
        return;
      }
      if (action === "install") {
        const source =
          parsed.operand ||
          (await this.promptForAgentPluginSource(projectScope?.rootPath));
        if (!source) return;
        const target = await this.pickAgentPluginInstallTarget(projectScope);
        if (!target) return;
        const prepared = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Acquiring and validating Agent Plugin…",
            cancellable: false,
          },
          () =>
            host.prepareInstall(source, {
              cwd: projectScope?.rootPath,
              ref: parsed.ref,
              target,
            }),
        );
        try {
          const selected = await this.pickAgentPluginCandidate(
            prepared.candidates,
          );
          if (!selected) return;
          const enabled = await this.reviewAgentPluginInstall(
            selected,
            prepared.acquired.source.display,
            undefined,
            prepared.target,
            prepared.shareability,
          );
          if (enabled === undefined) return;
          const row = await host.commitPrepared({
            prepared,
            candidate: selected,
            enabled,
          });
          this.showAgentPluginCommitResult(
            row,
            `Installed Agent Plugin '${row.manifestName}' ${row.enabled ? "and enabled it" : "disabled"}.`,
          );
        } finally {
          await prepared.acquired.cleanup();
        }
        return;
      }
      if (action === "enable" || action === "disable") {
        const id = await this.resolveAgentPluginInstallId(
          parsed.operand,
          action,
        );
        if (!id) return;
        await host.setEnabled(id, action === "enable");
        vscode.window.showInformationMessage(
          `${action === "enable" ? "Enabled" : "Disabled"} Agent Plugin '${id}'.`,
        );
        return;
      }
      if (action === "remove" || action === "uninstall" || action === "rm") {
        const id = await this.resolveAgentPluginInstallId(
          parsed.operand,
          "uninstall",
        );
        if (!id) return;
        const confirm = await vscode.window.showWarningMessage(
          `Uninstall Agent Plugin '${id}'? Immutable package bytes remain until a safe purge after all AgentLink windows close.`,
          { modal: true },
          "Uninstall",
        );
        if (confirm !== "Uninstall") return;
        await host.remove(id);
        vscode.window.showInformationMessage(
          `Uninstalled Agent Plugin '${id}'.`,
        );
        return;
      }
      if (action === "update" || action === "reinstall") {
        const id = await this.resolveAgentPluginInstallId(
          parsed.operand,
          "update",
        );
        if (!id) return;
        const registry = await host.list();
        const existing = registry.installs[id];
        const prepared = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Reacquiring Agent Plugin '${id}'…`,
            cancellable: false,
          },
          () => host.prepareUpdate(id),
        );
        try {
          const selected = prepared.candidates[0];
          if (!selected) return;
          const enabled = await this.reviewAgentPluginInstall(
            selected,
            prepared.acquired.source.display,
            existing?.enabled,
            prepared.target,
            prepared.shareability,
          );
          if (enabled === undefined) return;
          const row = await host.commitPrepared({
            prepared,
            candidate: selected,
            enabled,
            scope: existing?.scope,
            replacingInstallInstanceId: id,
          });
          this.showAgentPluginCommitResult(
            row,
            `Updated Agent Plugin '${row.manifestName}' to ${row.currentDigest.slice(0, 12)}.`,
          );
        } finally {
          await prepared.acquired.cleanup();
        }
        return;
      }
      if (action === "purge") {
        const confirm = await vscode.window.showWarningMessage(
          "Request removal of unreferenced Agent Plugin package generations? Purge runs only on a later safe startup after all AgentLink windows have closed.",
          { modal: true },
          "Request Purge",
        );
        if (confirm !== "Request Purge") return;
        await host.requestPurge();
        vscode.window.showInformationMessage(
          "Agent Plugin package purge requested. Close all AgentLink windows before the next startup to allow safe cleanup.",
        );
        return;
      }
      vscode.window.showInformationMessage(
        "Usage: /plugin <install|install-declared|list|enable|disable|update|uninstall|purge> [source|name|install-id] [--ref <branch-or-tag>]",
      );
    } catch (error) {
      this.log(`[plugins] Slash command failed: ${String(error)}`);
      vscode.window.showErrorMessage(
        `Agent Plugin operation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async promptForAgentPluginSource(
    cwd?: string,
  ): Promise<string | undefined> {
    const source = await vscode.window.showInputBox({
      title: "Install Agent Plugin",
      prompt:
        "Enter a Git URL/SSH remote, HTTP(S) archive URL, file URL, directory, plugin.json, ZIP, or TAR path",
      placeHolder: "https://host/owner/plugin.git or ./path/to/plugin.zip",
      ignoreFocusOut: true,
    });
    if (source?.trim()) return source.trim();
    const picked = await vscode.window.showOpenDialog({
      title: "Choose Agent Plugin directory, manifest, or archive",
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      ...(cwd ? { defaultUri: vscode.Uri.file(cwd) } : {}),
      filters: {
        "Agent Plugin sources": [
          "json",
          "zip",
          "tar",
          "gz",
          "tgz",
          "bz2",
          "xz",
        ],
      },
    });
    return picked?.[0]?.fsPath;
  }

  private async pickAgentPluginInstallTarget(
    currentScope?: Readonly<SessionProjectScope>,
  ): Promise<AgentPluginInstallTarget | undefined> {
    const availableProjects = this.getWorkspaceProjects()
      .filter(
        (project) =>
          project.availability.status === "available" &&
          project.rootPath !== undefined,
      )
      .sort((left, right) => {
        if (left.id === currentScope?.projectId) return -1;
        if (right.id === currentScope?.projectId) return 1;
        return left.name.localeCompare(right.name);
      });
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: "Global",
          description: "Available in every project on this machine",
          target: { kind: "global" } as AgentPluginInstallTarget,
        },
        ...availableProjects.map((project) => ({
          label: project.name,
          description:
            project.id === currentScope?.projectId
              ? "Current project"
              : "Project install",
          detail: project.rootPath,
          target: {
            kind: "project",
            scope: createSessionProjectScope(project),
          } as AgentPluginInstallTarget,
        })),
      ],
      {
        title: "Choose Agent Plugin install target",
        placeHolder: "Install globally or for one workspace folder",
        ignoreFocusOut: true,
      },
    );
    return selected?.target;
  }

  private async pickAgentPluginCandidate(
    candidates: readonly AgentPluginInstallCandidate[],
  ): Promise<AgentPluginInstallCandidate | undefined> {
    if (candidates.length === 1) return candidates[0];
    const selected = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: candidate.snapshot.manifest?.name ?? candidate.relativePath,
        description: candidate.snapshot.manifest?.version,
        detail: `${candidate.relativePath} · ${candidate.snapshot.skills.length} skill(s) · ${Object.keys(candidate.snapshot.mcp?.servers ?? {}).length} MCP server(s)`,
        candidate,
      })),
      {
        title: "Select Agent Plugin from source",
        placeHolder: "The source contains multiple standards-compliant plugins",
        ignoreFocusOut: true,
      },
    );
    return selected?.candidate;
  }

  private async reviewAgentPluginInstall(
    candidate: AgentPluginInstallCandidate,
    source: string,
    currentEnabled?: boolean,
    target: Readonly<AgentPluginInstallTarget> = { kind: "global" },
    shareability:
      | "shareable"
      | "not-shareable"
      | "not-applicable" = "not-applicable",
  ): Promise<boolean | undefined> {
    const manifest = candidate.snapshot.manifest;
    if (!manifest) return undefined;
    const mcpServers = Object.entries(candidate.snapshot.mcp?.servers ?? {});
    const stdio = mcpServers.filter(([, server]) => server.type === "stdio");
    const remote = mcpServers.filter(([, server]) => server.type !== "stdio");
    const author = manifest.author?.name ?? "Not declared";
    const detail = [
      `Source: ${source}`,
      `Plugin: ${manifest.name}${manifest.version ? ` ${manifest.version}` : ""}`,
      `Author: ${author} · License: ${manifest.license ?? "Not declared"}`,
      `Digest: ${candidate.digest}`,
      `Target: ${target.kind === "global" ? "Global" : `Project ${target.scope.displayName}`}`,
      ...(target.kind === "project"
        ? [
            shareability === "shareable"
              ? `This install will write or update ${path.join(target.scope.rootPath ?? "<project>", ".agentlink", "plugins.json")}.`
              : "This source is not shareable; the project install will remain machine-local and no declaration file will be changed.",
          ]
        : []),
      `Contents: ${candidate.snapshot.skills.length} skill(s), ${stdio.length} local stdio MCP server(s), ${remote.length} remote MCP server(s), ${
        candidate.snapshot.hooks.flatMap((source) =>
          Object.values(source.hooks)
            .flatMap((groups) => groups ?? [])
            .flatMap((group) => group.hooks),
        ).length
      } lifecycle hook handler(s)`,
      ...(candidate.snapshot.hooks.length > 0
        ? [
            `Hook commands: ${
              candidate.snapshot.hooks
                .flatMap((source) =>
                  Object.entries(source.hooks).flatMap(([event, groups]) =>
                    (groups ?? []).flatMap((group) =>
                      group.hooks.flatMap((handler) =>
                        handler.type === "command"
                          ? [
                              `${event}${group.matcher ? ` [${group.matcher}]` : ""}: ${handler.command}`,
                            ]
                          : [],
                      ),
                    ),
                  ),
                )
                .join("; ") || "No command handlers"
            }`,
            "WARNING: enabled plugin command hooks execute local code outside AgentLink's command sandbox.",
          ]
        : []),
      ...(stdio.length > 0
        ? [
            `Local commands: ${stdio
              .map(([name, server]) =>
                server.type === "stdio"
                  ? `${name}: ${[server.command, ...(server.args ?? [])].join(" ")}`
                  : name,
              )
              .join("; ")}`,
            "WARNING: enabled stdio MCP servers execute local code outside AgentLink's command sandbox.",
          ]
        : []),
      ...(candidate.snapshot.skills.length > 0
        ? [
            `Skills: ${candidate.snapshot.skills.map((skill) => skill.name).join(", ")}`,
            "Skill instructions may ask the agent to run bundled scripts; normal AgentLink command approval still applies.",
          ]
        : []),
      ...(remote.length > 0
        ? [
            `Remote MCP: ${remote
              .map(([name, server]) =>
                server.type === "stdio" ? name : `${name}: ${server.url}`,
              )
              .join("; ")}`,
          ]
        : []),
      "Plugin metadata never grants command, write, network, native-tool, or MCP-tool approval. Hook control decisions are limited to their documented lifecycle event and do not grant AgentLink tool authority.",
    ].join("\n\n");
    const enableLabel =
      currentEnabled === undefined ? "Install and Enable" : "Update and Enable";
    const disabledLabel =
      currentEnabled === undefined ? "Install Disabled" : "Update Disabled";
    const choice = await vscode.window.showWarningMessage(
      detail,
      { modal: true },
      enableLabel,
      disabledLabel,
    );
    if (!choice) return undefined;
    return choice === enableLabel;
  }

  private showAgentPluginCommitResult(
    result: Awaited<ReturnType<AgentPluginManagerHost["commitPrepared"]>>,
    successMessage: string,
  ): void {
    if (result.declarationOutcome.status === "failed") {
      vscode.window.showWarningMessage(
        `${successMessage} The machine-local install succeeded, but .agentlink/plugins.json could not be updated: ${result.declarationOutcome.message}`,
      );
      return;
    }
    vscode.window.showInformationMessage(successMessage);
  }

  private async resolveAgentPluginInstallId(
    query: string,
    action: string,
  ): Promise<string | undefined> {
    const host = this.agentPluginManagerHost;
    if (!host) return undefined;
    const registry = await host.list();
    const rows = Object.values(registry.installs);
    if (query) {
      const exact = rows.find(
        (row) => row.installInstanceId === query || row.manifestName === query,
      );
      if (exact) return exact.installInstanceId;
    }
    const picked = await vscode.window.showQuickPick(
      rows.map((row) => ({
        label: row.manifestName,
        description: `${row.enabled ? "enabled" : "disabled"} · ${row.scope.kind}`,
        detail: `${row.installInstanceId} · ${row.currentDigest.slice(0, 12)}`,
        installInstanceId: row.installInstanceId,
      })),
      {
        title: `${action[0]?.toUpperCase()}${action.slice(1)} Agent Plugin`,
        placeHolder: query
          ? `No exact plugin matched '${query}'. Choose one instead.`
          : "Choose an installed plugin",
        ignoreFocusOut: true,
      },
    );
    return picked?.installInstanceId;
  }

  private async showInstalledAgentPlugins(
    projectScope?: Readonly<SessionProjectScope>,
  ): Promise<void> {
    const host = this.agentPluginManagerHost;
    if (!host) return;
    const snapshot = await host.getSnapshot(projectScope);
    const lines = snapshot.entries.map((entry) => {
      if (entry.status === "declared") {
        const source = entry.declaration
          ? "git" in entry.declaration.source
            ? `${entry.declaration.source.git} @ ${entry.declaration.source.commit}`
            : entry.declaration.source.path
          : "unknown source";
        return `declared  ${entry.manifestName}\n  ${source}\n  Install with /plugin install-declared ${entry.manifestName}`;
      }
      const row = entry.install!;
      const state = !row.enabled
        ? "disabled"
        : entry.effective === false
          ? "shadowed"
          : "enabled ";
      const shareability =
        entry.shareability === "not-shareable" ? " · not shareable" : "";
      const shadowed = entry.shadowedByInstallInstanceId
        ? `\n  shadowed by ${entry.shadowedByInstallInstanceId}`
        : "";
      return `${state}  ${row.manifestName}${row.manifestVersion ? ` ${row.manifestVersion}` : ""}\n  ${row.installInstanceId}\n  ${row.scope.kind} · ${row.source.kind}${shareability} · ${row.currentDigest}${shadowed}`;
    });
    const diagnostics = snapshot.declarationDiagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity}: ${diagnostic.message}${diagnostic.name ? ` (${diagnostic.name})` : ""}`,
    );
    this.outputChannel.appendLine(
      lines.length === 0 && diagnostics.length === 0
        ? "No Agent Plugins are installed or declared. Use /plugin install <source>."
        : [
            `Agent Plugins (${snapshot.entries.length})${projectScope ? ` for ${projectScope.displayName}` : ""}`,
            "",
            ...lines,
            ...(diagnostics.length > 0
              ? ["", "Declaration diagnostics", ...diagnostics]
              : []),
          ].join("\n"),
    );
    this.outputChannel.show(true);
  }

  private async handleBtwQuestion(
    question: string,
    sessionId: string,
  ): Promise<void> {
    const requestId = randomUUID();
    const controller = new AbortController();
    this.pendingBtwRequests.set(requestId, { controller, sessionId });

    this.postMessage({
      type: "agentBtwLoading",
      sessionId,
      requestId,
      question,
    } as ExtensionToWebview);

    const tools: string[] = [];
    const warnings: string[] = [];
    let answer = "";
    let budget = {
      apiTurns: 0,
      maxApiTurns: 0,
      toolCalls: 0,
      maxToolCalls: 0,
    };

    try {
      const result = await this.sessionManager?.runBtwQuestion(question, {
        sessionId,
        signal: controller.signal,
        onProgress: (event) => {
          switch (event.type) {
            case "text_delta":
              answer += event.text;
              break;
            case "tool":
              tools.push(event.toolName);
              break;
            case "warning":
              warnings.push(event.message);
              break;
            case "budget":
              budget = {
                apiTurns: event.apiTurns,
                maxApiTurns: event.maxApiTurns,
                toolCalls: event.toolCalls,
                maxToolCalls: event.maxToolCalls,
              };
              break;
          }
          this.postMessage({
            type: "agentBtwProgress",
            sessionId,
            requestId,
            answer,
            tools: [...tools],
            warnings: [...warnings],
            budget,
          } as ExtensionToWebview);
        },
      });
      if (!result) {
        throw new Error("No active agent session manager");
      }

      this.postMessage({
        type: "agentBtwResponse",
        sessionId,
        requestId,
        question,
        answer: result.answer,
        cancelled: result.cancelled,
        tools: result.toolCalls.map((t) => t.toolName),
        warnings: result.warnings,
        budget: {
          apiTurns: result.apiTurns,
          maxApiTurns: result.maxApiTurns,
          toolCalls: result.toolCallCount,
          maxToolCalls: result.maxToolCalls,
        },
      } as ExtensionToWebview);

      const toolSummary =
        result.toolCalls.length > 0
          ? ` tools=${result.toolCalls.map((t) => t.toolName).join(",")}`
          : "";
      this.log(
        `[btw] ${result.cancelled ? "cancelled" : "answered"} (${result.inputTokens}in/${result.outputTokens}out ${result.apiTurns}/${result.maxApiTurns}turns${toolSummary})`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`[btw] error: ${errorMsg}`);
      this.postMessage({
        type: "agentBtwResponse",
        sessionId,
        requestId,
        question,
        answer: errorMsg,
        error: true,
      } as ExtensionToWebview);
    } finally {
      this.pendingBtwRequests.delete(requestId);
    }
  }

  /** Cancel an in-flight /btw side question, aborting its side session. */
  private cancelBtwQuestion(requestId: string, sessionId: string): void {
    const request = this.pendingBtwRequests.get(requestId);
    if (request?.sessionId === sessionId) request.controller.abort();
  }

  private async handleWorktreeSlashCommand(
    rawArgs: string,
    sessionId: string,
    command: "worktree" | "review" = "worktree",
  ): Promise<void> {
    for (const [requestId, setup] of this.pendingWorktreeSetups) {
      if (setup.sessionId === sessionId) this.cancelWorktreeSetup(requestId);
    }

    const requestId = randomUUID();
    const controller = new AbortController();
    this.pendingWorktreeSetups.set(requestId, {
      controller,
      sessionId,
      conversation: [],
    });
    this.postMessage({
      type: "agentWorktreeSetupStarted",
      sessionId,
      requestId,
      input: rawArgs.trim(),
    } as ExtensionToWebview);

    let parsed: ReturnType<typeof parseWorktreeSlashCommand>;
    try {
      parsed =
        command === "review"
          ? {
              draft: createGitHubReviewWorktreeDraft(rawArgs),
              needsConfiguration: false,
            }
          : parseWorktreeSlashCommand(rawArgs);
    } catch (error) {
      this.finishWorktreeSetup(requestId, "error", String(error));
      return;
    }

    const sourcePath = this.getSessionProjectRoot(sessionId);
    if (!sourcePath) {
      this.finishWorktreeSetup(
        requestId,
        "error",
        "Open an available local workspace folder before starting a worktree.",
      );
      return;
    }
    const setup = this.pendingWorktreeSetups.get(requestId)!;
    setup.draft = parsed.draft;
    setup.sourcePath = sourcePath;

    if (!parsed.needsConfiguration) {
      const config = { ...parsed.draft, sourcePath } as WorktreeSetupConfig;
      setup.config = config;
      this.postMessage({
        type: "agentWorktreeSetupReady",
        sessionId,
        requestId,
        answer: "Configuration ready.",
        config,
        tools: [],
        warnings: [],
        budget: {
          apiTurns: 0,
          maxApiTurns: 0,
          toolCalls: 0,
          maxToolCalls: 0,
        },
      } as ExtensionToWebview);
      return;
    }

    await this.runWorktreeSetupTurn(requestId);
  }

  private async runWorktreeSetupTurn(requestId: string): Promise<void> {
    const setup = this.pendingWorktreeSetups.get(requestId);
    if (
      !setup?.draft ||
      !setup.sourcePath ||
      setup.running ||
      !this.sessionManager
    ) {
      return;
    }
    setup.running = true;
    const controller = setup.controller;

    let answer = "";
    const tools: string[] = [];
    const warnings: string[] = [];
    let budget: BtwBudget = {
      apiTurns: 0,
      maxApiTurns: 0,
      toolCalls: 0,
      maxToolCalls: 0,
    };

    try {
      const result = await this.sessionManager.runWorktreeSetup(setup.draft, {
        sessionId: setup.sessionId,
        signal: controller.signal,
        conversation: setup.conversation,
        onProgress: (event) => {
          switch (event.type) {
            case "text_delta":
              answer += event.text;
              break;
            case "tool":
              tools.push(event.toolName);
              break;
            case "warning":
              warnings.push(event.message);
              break;
            case "budget":
              budget = {
                apiTurns: event.apiTurns,
                maxApiTurns: event.maxApiTurns,
                toolCalls: event.toolCalls,
                maxToolCalls: event.maxToolCalls,
              };
              break;
          }
          this.postMessage({
            type: "agentWorktreeSetupProgress",
            sessionId: setup.sessionId,
            requestId,
            answer: answer.replace(/<worktree-config>[\s\S]*$/i, "").trim(),
            tools: [...tools],
            warnings: [...warnings],
            budget,
          } as ExtensionToWebview);
        },
      });
      if (result.cancelled || controller.signal.aborted) {
        this.finishWorktreeSetup(requestId, "cancelled", "Setup cancelled.");
        return;
      }

      const extracted = extractWorktreeSetupConfig(result.answer);
      if (extracted.error) throw new Error(extracted.error);
      if (!extracted.draft) {
        const question = extracted.displayText || result.answer.trim();
        if (!question) {
          throw new Error(
            "The setup agent stopped without a question or launch configuration.",
          );
        }
        setup.conversation.push({ role: "assistant", text: question });
        this.postMessage({
          type: "agentWorktreeSetupAwaitingInput",
          sessionId: setup.sessionId,
          requestId,
          answer: question,
          conversation: [...setup.conversation],
          tools: result.toolCalls.map((tool) => tool.toolName),
          warnings: result.warnings,
          budget: {
            apiTurns: result.apiTurns,
            maxApiTurns: result.maxApiTurns,
            toolCalls: result.toolCallCount,
            maxToolCalls: result.maxToolCalls,
          },
        } as ExtensionToWebview);
        return;
      }
      const config = {
        ...extracted.draft,
        ...setup.draft,
        sourcePath: setup.sourcePath,
      } as WorktreeSetupConfig;
      setup.config = config;
      this.postMessage({
        type: "agentWorktreeSetupReady",
        sessionId: setup.sessionId,
        requestId,
        answer: extracted.displayText || "Configuration ready.",
        config,
        tools: result.toolCalls.map((tool) => tool.toolName),
        warnings: result.warnings,
        budget: {
          apiTurns: result.apiTurns,
          maxApiTurns: result.maxApiTurns,
          toolCalls: result.toolCallCount,
          maxToolCalls: result.maxToolCalls,
        },
      } as ExtensionToWebview);
    } catch (error) {
      if (controller.signal.aborted) {
        this.finishWorktreeSetup(requestId, "cancelled", "Setup cancelled.");
      } else {
        this.finishWorktreeSetup(
          requestId,
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      const current = this.pendingWorktreeSetups.get(requestId);
      if (current === setup) current.running = false;
    }
  }

  private async launchConfiguredWorktree(
    requestId: string,
    autoSubmit: boolean,
  ): Promise<void> {
    const setup = this.pendingWorktreeSetups.get(requestId);
    if (!setup?.config || !this.sessionManager) return;
    setup.config = { ...setup.config, autoSubmit };
    this.postMessage({
      type: "agentWorktreeSetupLaunching",
      sessionId: setup.sessionId,
      requestId,
      config: setup.config,
    } as ExtensionToWebview);

    try {
      const result = await this.sessionManager.startWorktreeAgent(
        setup.config,
        {
          approvalDecision: autoSubmit
            ? "approve-autosubmit"
            : "approve-prefill",
        },
      );
      const text = result.content.find((item) => item.type === "text")?.text;
      const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      const status = payload.status;
      const phase =
        status === "opened"
          ? "opened"
          : status === "rejected"
            ? "rejected"
            : "error";
      const message =
        typeof payload.message === "string"
          ? payload.message
          : phase === "opened"
            ? "Worktree opened in a new VS Code window."
            : typeof payload.error === "string"
              ? payload.error
              : "Worktree launch failed.";
      this.finishWorktreeSetup(requestId, phase, message, setup.config);
    } catch (error) {
      this.finishWorktreeSetup(
        requestId,
        "error",
        error instanceof Error ? error.message : String(error),
        setup.config,
      );
    }
  }

  private cancelWorktreeSetup(requestId: string): void {
    const setup = this.pendingWorktreeSetups.get(requestId);
    if (!setup) return;
    setup.controller.abort();
    this.finishWorktreeSetup(requestId, "cancelled", "Setup cancelled.");
  }

  private finishWorktreeSetup(
    requestId: string,
    phase: "opened" | "rejected" | "cancelled" | "error",
    message: string,
    config?: WorktreeSetupConfig,
  ): void {
    const setup = this.pendingWorktreeSetups.get(requestId);
    if (!setup) return;
    this.pendingWorktreeSetups.delete(requestId);
    this.postMessage({
      type: "agentWorktreeSetupResult",
      sessionId: setup.sessionId,
      requestId,
      phase,
      message,
      ...(config ? { config } : {}),
    } as ExtensionToWebview);
  }

  /**
   * Promote a /btw answer into the main conversation as a user-visible
   * exchange, so a useful side answer isn't lost when the panel is dismissed.
   */
  private async promoteBtwAnswer(
    question: string,
    answer: string,
    sessionId?: string,
  ): Promise<void> {
    const session = sessionId
      ? this.sessionManager?.getSession(sessionId)
      : this.sessionManager?.getForegroundSession();
    if (!session) return;
    session.addUserMessage(`/btw ${question}`, {
      displayText: `/btw ${question}`,
      isSlashCommand: true,
      slashCommandLabel: "/btw",
    });
    session.appendAssistantTurn([{ type: "text", text: answer }]);
    this.sessionManager?.saveSession(session.id);
    this.postMessage(
      this.buildSessionLoadedMessage(session, {
        checkpoints: this.getSessionCheckpoints(session.id),
        tailTurns: 0,
      }),
    );
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
      previewResult.projectId,
      previewResult.workspaceRevision,
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

  private async sendDebugInfo(requestedSessionId?: string): Promise<void> {
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

    // Get system prompt from the requested session. If no session exists yet
    // (fresh chat), build a fallback prompt for the default mode so the
    // Environment panel can still show the System Prompt section.
    const foregroundSession = this.sessionManager?.getForegroundSession();
    const fg = requestedSessionId
      ? (this.sessionManager?.getSession?.(requestedSessionId) ??
        (foregroundSession?.id === requestedSessionId
          ? foregroundSession
          : undefined))
      : foregroundSession;
    const sessionId = fg?.id;
    const debugRoot = fg?.projectScope
      ? fg.projectScope.rootPath
      : fg
        ? undefined
        : this.cwd;
    const activeFilePath = fg
      ? fg.activeFileContext?.status === "accepted"
        ? fg.activeFileContext.activeFilePath
        : undefined
      : vscode.window.activeTextEditor?.document.uri.fsPath;
    if (fg?.projectScope) {
      info["project.id"] = fg.projectScope.projectId;
      info["project.availability"] = fg.projectAvailability;
      if (fg.activeFileContext) {
        info["project.activeFileContext"] =
          fg.activeFileContext.status === "accepted"
            ? "accepted"
            : `ignored:${fg.activeFileContext.reason}`;
      }
    }
    let systemPrompt = fg?.systemPrompt;
    if (!systemPrompt && debugRoot) {
      try {
        const mode = fg?.mode ?? "code";
        const model = fg?.model ?? this.sessionManager?.getConfig().model;
        const providerId = model
          ? providerRegistry.tryResolveProvider(model)?.id
          : undefined;
        systemPrompt = await buildSystemPrompt(mode, debugRoot, {
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
    if (debugRoot) {
      try {
        const blocks = await loadAllInstructionBlocks(debugRoot, {
          activeFilePath,
        });
        loadedInstructions = blocks.map((block) =>
          formatInstructionDebugInfo(block, debugRoot, activeFilePath),
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
      sessionId,
      info,
      systemPrompt: systemPrompt ?? undefined,
      loadedInstructions,
    });
  }

  private async resolveAttachments(
    text: string,
    attachments: string[],
    projectRoot: string,
  ): Promise<ResolvedAttachments> {
    return resolveProjectAttachments(text, attachments, projectRoot);
  }

  private async searchWorkspaceFiles(
    query: string,
    requestId: string,
  ): Promise<void> {
    const selection = this.getCustomizationSelection();
    if (!selection) {
      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files: [],
      });
      return;
    }

    try {
      const files = await this.searchBrowserFiles(
        query,
        selection.scope.projectId,
      );
      this.postMessage({
        type: "agentFileSearchResults",
        requestId,
        files,
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
      if (provider && fg) {
        agentContext = {
          provider,
          model: getProviderAuxiliaryModel(provider, fg.model),
        };
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
    if (this.approvalStateTransitionDepth > 0) {
      this.approvalStatePublishPending = true;
      return;
    }
    if (!this.sessionManager) return;

    this.postMessage({
      type: "stateUpdate",
      state: this.buildChatState(this.sessionManager.getForegroundSession()),
    });
    this.postMessage({
      type: "agentSessionUpdate",
      sessions: this.sessionManager.getSessionInfos(),
    });
  }

  private buildChatState(session: AgentSession | undefined): ChatState {
    if (!this.sessionManager) {
      throw new Error("Agent session manager is unavailable");
    }
    const modelId =
      session?.model ?? this.sessionManager.getConfig?.().model ?? "";
    const condenseThreshold = this.getConfiguredCondenseThreshold(
      modelId,
      session?.projectScope,
    );
    const contextBudget = this.buildContextBudget(
      session,
      modelId,
      condenseThreshold,
    );
    const projects = this.getProjectInfos();
    const defaultProjectId =
      this.sessionManager.getDefaultProjectScope?.()?.projectId ?? null;
    const approvalMode = this.getBrowserSessionApprovalMode(
      session?.id,
      session?.projectScope,
    );
    return {
      sessionId: session?.id ?? null,
      projects,
      defaultProjectId,
      project: session?.projectScope
        ? {
            projectId: session.projectScope.projectId,
            displayName: session.projectScope.displayName,
            availability:
              session.projectAvailability === "available" &&
              projects.find(
                (project) =>
                  project.projectId === session.projectScope!.projectId,
              )?.availability === "available"
                ? "available"
                : "unavailable",
          }
        : (projects.find((project) => project.projectId === defaultProjectId) ??
          null),
      mode: session?.mode ?? (this.hasWorkspaceProjects() ? "code" : "ask"),
      model: modelId,
      streaming:
        session?.status === "streaming" ||
        session?.status === "tool_executing" ||
        session?.status === "awaiting_approval",
      interrupted:
        Boolean(session?.runState) &&
        session?.runState?.phase !== "awaiting_question" &&
        session?.status !== "streaming" &&
        session?.status !== "tool_executing" &&
        session?.status !== "awaiting_approval",
      condenseThreshold,
      contextBudget,
      contextHealth: this.contextHealth,
      reasoningEffort: session?.reasoningEffort ?? "high",
      thinkingEnabled: (session?.reasoningEffort ?? "high") !== "none",
      // Use the selected session's ID so write approval state remains isolated.
      agentWriteApproval: this.approvalManager?.getAgentWriteApprovalState(
        session?.id ?? "agent",
      ),
      ...approvalMode,
      configuredCommandApprovalPolicy: this.getConfiguredCommandApprovalPolicy(
        session?.projectScope,
      ),
      revertRecoveryNotice: session
        ? this.formatRevertRecoveryNoticeForSession(session.id)
        : null,
    };
  }

  /**
   * Re-send model list to the webview. Called externally when provider auth
   * state changes (e.g. Codex sign-in/sign-out).
   */
  public refreshModels(): void {
    // Force a dynamic refresh (bypass TTL) — e.g. provider auth state changed.
    this.maybeRefreshAnthropicModels({ force: true });
    void this.sendModelsUpdate();
    this.notifyBrowserModelsChanged?.();
  }

  public setSidebarWriteApproval(
    selection: AgentWriteApprovalSelection,
    approvalSessionIds: readonly string[],
  ): boolean {
    if (!this.approvalManager || !this.sessionManager) return false;
    const liveSessionIds =
      this.sessionManager.getSessionInfos?.().map((session) => session.id) ??
      [];
    const fallbackSessionId = this.sessionManager.getForegroundSession()?.id;
    const targetSessionIds = [
      ...new Set([
        ...approvalSessionIds,
        ...liveSessionIds,
        ...(fallbackSessionId ? [fallbackSessionId] : []),
      ]),
    ];

    return this.withApprovalStateTransition(() => {
      const approveForMeSessionIds = targetSessionIds.filter((sessionId) => {
        const session = this.sessionManager!.getSession?.(sessionId);
        return (
          this.sessionManager!.getCommandApprovalPolicy(
            sessionId,
            this.getConfiguredCommandApprovalPolicy(session?.projectScope),
          ) === "approve-for-me"
        );
      });
      for (const sessionId of approveForMeSessionIds) {
        const session = this.sessionManager!.getSession?.(sessionId);
        this.sessionManager!.setCommandApprovalPolicy(
          sessionId,
          this.getConfiguredCommandApprovalPolicy(session?.projectScope),
        );
      }

      this.approvalManager!.resetAgentWriteApproval();
      if (selection === "prompt") return true;

      const targetSessionId = fallbackSessionId ?? targetSessionIds[0];
      if (!targetSessionId) return false;
      const targetSession = this.sessionManager!.getSession?.(targetSessionId);
      const targetProjectId = targetSession?.projectScope.projectId;
      const writeTargets =
        selection === "session" ? targetSessionIds : [targetSessionId];
      const approvedSessionIds = new Set<string>();
      let success = true;
      for (const sessionId of writeTargets) {
        const session = this.sessionManager!.getSession?.(sessionId);
        const updated = this.approvalManager!.setAgentWriteApprovalSelection(
          sessionId,
          selection,
          session?.projectScope.rootPath,
        );
        if (updated) approvedSessionIds.add(sessionId);
        success = updated && success;
      }

      for (const sessionId of approveForMeSessionIds) {
        const session = this.sessionManager!.getSession?.(sessionId);
        const covered =
          selection === "global"
            ? success
            : selection === "project"
              ? success && session?.projectScope.projectId === targetProjectId
              : approvedSessionIds.has(sessionId);
        if (!covered) continue;
        const restored = this.setSessionCommandApprovalPolicy(
          sessionId,
          "approve-for-me",
          session?.projectScope.rootPath,
        );
        success = (restored?.ok ?? false) && success;
      }
      return success;
    });
  }

  /**
   * Inject a prompt into the chat input and optionally focus the panel.
   * Used by code actions (Fix/Explain with AgentLink).
   */
  public async startPromptInMode(opts: {
    prompt: string;
    mode?: string;
    autoSubmit?: boolean;
    commandApprovalPolicy?: CommandApprovalPolicy;
    approvalPolicy?: SessionApprovalMode["approvalPolicy"];
    approvalReviewer?: SessionApprovalMode["approvalReviewer"];
    executionPreset?: SessionApprovalMode["executionPreset"];
  }): Promise<string> {
    const mode = opts.mode?.trim();
    if (!this.sessionManager) {
      throw new Error("Agent session manager is unavailable");
    }
    let current = this.sessionManager.getForegroundSession();
    if (!current) {
      current = await this.sessionManager.createSession(mode || "code");
      this.postSessionLoaded(current, {
        checkpoints: this.getSessionCheckpoints(current.id),
        tailTurns: 0,
      });
    } else if (mode) {
      const previousMode = current.mode;
      const switched = await this.sessionManager.switchForegroundMode(mode, {
        initialArchitectReviewApproved: true,
      });
      if (switched) {
        current = switched;
        if (previousMode !== switched.mode) {
          this.recordSurfaceChange(switched, {
            mode: { previousMode, mode: switched.mode },
          });
        }
        this.reconcileSessionApprovalAfterModeSwitch(switched.id);
      }
    }
    if (opts.commandApprovalPolicy) {
      this.withApprovalStateTransition(() => {
        const result = this.setSessionCommandApprovalPolicy(
          current.id,
          opts.commandApprovalPolicy!,
          current.projectScope?.rootPath,
        );
        if (result && !result.ok) {
          throw new Error(
            "Could not establish the write approval required by Approve for Me.",
          );
        }
        if (
          opts.approvalPolicy &&
          opts.approvalReviewer &&
          opts.executionPreset
        ) {
          this.sessionManager!.setSessionApprovalMode(current.id, {
            commandApprovalPolicy: opts.commandApprovalPolicy!,
            approvalPolicy: opts.approvalPolicy,
            approvalReviewer: opts.approvalReviewer,
            executionPreset: opts.executionPreset,
          });
        } else if (!result) {
          this.sessionManager!.setCommandApprovalPolicy(
            current.id,
            opts.commandApprovalPolicy!,
          );
        }
        this.sendInitialState();
      });
    } else if (mode) {
      this.sendInitialState();
    }
    if (opts.autoSubmit && opts.prompt.trim()) {
      const sessionId = current.id;
      const prompt = opts.prompt;
      setTimeout(() => {
        const session = this.sessionManager?.getSession(sessionId);
        if (!session || !this.sessionManager) return;
        let removeStartupListener: (() => void) | undefined;
        removeStartupListener = this.sessionManager.addAgentEventListener(
          (eventSessionId, event) => {
            if (eventSessionId !== sessionId || event.type !== "api_request")
              return;
            removeStartupListener?.();
            removeStartupListener = undefined;
            const committedSession = this.sessionManager?.getSession(sessionId);
            if (!committedSession) return;
            this.postSessionLoaded(committedSession, {
              checkpoints: this.getSessionCheckpoints(sessionId),
              tailTurns: 0,
            });
          },
        );
        void this.sessionManager
          .sendMessage(sessionId, prompt, session.mode, {
            reasoningEffort: session.reasoningEffort,
            thinkingEnabled: session.reasoningEffort !== "none",
            activeFilePath: session.activeFilePath,
            displayText: prompt,
            origin: "vscode",
          })
          .catch((error) => {
            this.log(`[worktree-agent] startup prompt failed: ${error}`);
          })
          .finally(() => removeStartupListener?.());
      }, 0);
    } else {
      this.injectPrompt(opts.prompt, [], false);
    }
    return current.id;
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

  private revealPanel(preserveFocus = true): void {
    if (this.view) {
      this.view.show(preserveFocus);
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

  private drainBrowserQueuedMessage(sessionId: string): void {
    const session = this.sessionManager?.getSession(sessionId);
    if (!session || this.projectedForegroundStore.sessionId !== sessionId)
      return;
    const queuedMessages = this.projectedForegroundState.messageQueue.filter(
      (entry) => entry.source === "browser",
    );
    if (queuedMessages.length === 0) return;

    for (const queued of queuedMessages) {
      this.applyProjectedAction({ type: "REMOVE_FROM_QUEUE", id: queued.id });
      this.sendOrQueueWebviewMessage({
        type: "agentRemoveQueuedMessage",
        sessionId,
        queueId: queued.id,
      });
    }

    const mode = session.mode;
    const reasoningEffort = session.reasoningEffort;
    const thinkingEnabled = reasoningEffort !== "none";
    const sendMessages = queuedMessages.map((queued) => {
      const documents = queued.documents?.filter(
        (
          document,
        ): document is { name: string; mimeType: string; base64: string } =>
          typeof document.base64 === "string",
      );
      return {
        id: queued.id,
        text: queued.fullText ?? queued.text,
        displayText: queued.text,
        isSlashCommand: queued.isSlashCommand,
        slashCommandLabel: queued.slashCommandLabel,
        images: queued.images,
        documents,
        displayMedia: mediaToDisplayMedia({
          images: queued.images,
          documents: queued.documents,
        }),
      };
    });

    for (const message of sendMessages) {
      this.postMessage({
        type: "agentCommittedUserMessage",
        sessionId,
        id: message.id,
        text: message.text,
        displayText: message.displayText,
        isSlashCommand: message.isSlashCommand,
        slashCommandLabel: message.slashCommandLabel,
        origin: "browser",
        displayMedia: message.displayMedia,
      });
    }

    this.sessionManager
      ?.sendMessage(sessionId, sendMessages[0]!.text, mode, {
        thinkingEnabled,
        reasoningEffort,
        activeFilePath: session.activeFilePath,
        displayText: sendMessages[0]!.displayText,
        isSlashCommand: sendMessages[0]!.isSlashCommand,
        slashCommandLabel: sendMessages[0]!.slashCommandLabel,
        origin: "browser",
        images: sendMessages[0]!.images,
        documents: sendMessages[0]!.documents,
        additionalMessages: sendMessages.slice(1).map((message) => ({
          text: message.text,
          displayText: message.displayText,
          isSlashCommand: message.isSlashCommand,
          slashCommandLabel: message.slashCommandLabel,
          origin: "browser",
          images: message.images,
          documents: message.documents,
        })),
      })
      .catch((err) => {
        this.log(`[error] browser queued send failed: ${err}`);
      });
  }

  private postMessage(msg: ExtensionToWebview): void {
    this.projectExtensionMessage(msg);
    this.sendOrQueueWebviewMessage(msg);
    this.postMessageToEditorPanes(msg);
  }

  /**
   * Periodic liveness beat to the sidebar webview so the UI can flag an
   * unresponsive extension host (stale-heartbeat tab indicator). Sent directly
   * to the webview — never queued, never projected to replay caches — because a
   * buffered heartbeat is worse than a missed one.
   */
  private startHostHeartbeat(): void {
    if (this.hostHeartbeatTimer) return;
    this.hostHeartbeatTimer = setInterval(() => {
      if (!this.webviewReady || !this.view) return;
      void Promise.resolve(
        this.view.webview.postMessage({
          type: "hostHeartbeat",
          at: Date.now(),
        } satisfies ExtensionToWebview),
      ).catch(() => {
        // Delivery failures are already surfaced by the regular message path;
        // the webview treats a missing beat as the signal.
      });
    }, HOST_HEARTBEAT_INTERVAL_MS);
  }

  private postChatTabActionMessage(
    msg: ExtensionToWebview,
    address?: ChatTabActionAddress,
  ): void {
    this.postMessage(msg);
    if (!address) return;
    const postToEditorPanes = this.chatTabPanelHost?.postMessage?.bind(
      this.chatTabPanelHost,
    );
    postToEditorPanes?.(
      msg,
      (candidate) =>
        candidate.controllerEpoch === address.controllerEpoch &&
        candidate.tabId === address.tabId &&
        candidate.sessionId === address.sessionId,
    );
  }

  private postMessageToEditorPanes(msg: ExtensionToWebview): void {
    const host = this.chatTabPanelHost;
    if (!host) return;
    const sessionId =
      msg.type === "stateUpdate"
        ? msg.state.sessionId
        : "sessionId" in msg
          ? msg.sessionId
          : undefined;
    if (typeof sessionId === "string") {
      host.postMessage(msg, (address) => address.sessionId === sessionId);
      return;
    }
    if (
      msg.type === "chatWorkspaceUpdate" ||
      msg.type === "agentModelsUpdate" ||
      msg.type === "agentSessionList" ||
      msg.type === "agentSessionUpdate" ||
      msg.type === "agentBgSessionsUpdate"
    ) {
      host.postMessage(msg);
    }
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
    this.updateBrowserGatewayThemeState(() => {
      this.webviewReady = false;
    });
    this.pendingMessages.push(msg);
  }

  private postSessionLoaded(
    session: AgentSession,
    opts?: {
      restored?: boolean;
      tailTurns?: number;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
      origin?: "focus";
    },
  ): void {
    this.withApprovalStateTransition(() => {
      const message = this.buildSessionLoadedMessage(session, opts);
      if (message.backgroundResults?.length) {
        this.sessionManager?.markBackgroundResultsAnnounced?.(
          message.backgroundResults.map((result) => result.sessionId),
        );
      }
      this.postMessage(message);

      if (session.runState?.phase === "awaiting_question") {
        this.restorePendingQuestionRecovery(session, session.runState.question);
      }
    });
  }

  private buildSessionLoadedMessage(
    session: AgentSession,
    opts?: {
      restored?: boolean;
      tailTurns?: number;
      checkpoints?: Array<{ turnIndex: number; checkpointId: string }>;
      origin?: "focus";
    },
  ): Extract<ExtensionToWebview, { type: "agentSessionLoaded" }> {
    // Deliver buffered deltas before the hydration snapshot so ordering stays
    // coherent: everything up to the snapshot arrives first, the snapshot
    // supersedes it, and only genuinely newer deltas follow.
    this.deltaBufferFlusher.flushNow();
    const all = session.getAllMessages();
    const tail = getTailChunkByUserTurns(
      all,
      opts?.tailTurns ?? RESTORE_TAIL_TURNS,
    );
    const backgroundResults =
      this.sessionManager?.getBackgroundCompletionsForParent?.(session.id) ??
      [];
    const streaming =
      session.status === "streaming" ||
      session.status === "tool_executing" ||
      session.status === "awaiting_approval";
    // Optional chaining tolerates stub sessions in tests; a real AgentSession
    // always exposes the live-tail snapshot.
    const inFlight = session.inFlightAssistantBlocks ?? [];
    return {
      type: "agentSessionLoaded",
      sessionId: session.id,
      transcriptRevision: session.transcriptRevision,
      title: session.title,
      // Project only the first user turn — projecting the whole transcript
      // here dominated restore hydration on multi-MB sessions.
      originalPrompt: projectFirstUserPrompt(all),
      mode: session.mode,
      model: session.model,
      messages: tail.chunk,
      messageIndexOffset: all.length - tail.chunk.length,
      todos: getLatestTodoState(all),
      lastInputTokens: session.lastInputTokens,
      lastOutputTokens: 0,
      backgroundResults:
        backgroundResults.length > 0 ? backgroundResults : undefined,
      restored: opts?.restored,
      checkpoints: opts?.checkpoints,
      userTurnOffset: tail.userTurnOffset,
      hasMoreBefore: tail.hasMoreBefore,
      inFlight: inFlight.length > 0 ? inFlight : undefined,
      streaming,
      // Same formula as the stateUpdate path, carried on the hydration so the
      // resume controls can appear as soon as the transcript does.
      interrupted:
        Boolean(session.runState) &&
        session.runState?.phase !== "awaiting_question" &&
        !streaming,
      origin: opts?.origin,
    };
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
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
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
    // Escape "<" so source containing "</script>" cannot break out of the
    // JSON data script tag below.
    const payload = JSON.stringify({ kind, source }).replace(/</g, "\\u003c");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "special-block-panel.js"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval' blob:; worker-src blob:; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data:;">
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
  <script id="special-block-data" type="application/json">${payload}</script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function classifyApprovalInterruptionReason(
  request: ApprovalRequest,
): string {
  if (request.recoveryAttempt) return "sandbox_native_retry";
  if (request.humanOnlyReason) {
    const normalized = request.humanOnlyReason.trim().toLowerCase();
    if (normalized.includes("repeated denial")) return "guardian_circuit_open";
    if (normalized.includes("prompt rule")) return "prompt_rule";
    if (normalized.includes("forbidden rule")) return "forbidden_rule";
    if (normalized.includes("native")) return "native_execution_human_only";
    const boundedHumanOnlyReasons = new Set([
      "authenticated-cli-config",
      "canonical-target-drift",
      "credential-store",
      "environment-secret",
      "guardian-denied",
      "inactive-auto-review-policy",
      "incomplete-write-evidence",
      "invalid-action",
      "operation-parameter-limit",
      "protected-instructions-or-memory",
      "symlink-ambiguous",
      "unresolved",
      "write-evidence-limit",
    ]);
    return boundedHumanOnlyReasons.has(normalized)
      ? `human_only:${normalized}`
      : "human_only";
  }
  const review = request.commandReview ?? request.networkReview;
  if (review?.status && review.status !== "reviewed") {
    return `guardian_${review.status}`;
  }
  if (review?.outcome === "deny") return "guardian_denied";
  if (request.kind === "network") return "network_destination_approval";
  if (request.kind === "path") return "outside_path_approval";
  if (request.kind === "write") {
    return request.outsideWorkspace
      ? "outside_write_approval"
      : "write_approval";
  }
  if (request.kind === "rename") return "rename_approval";
  if (request.kind === "mcp") return "mcp_tool_approval";
  if (request.kind === "mode-switch") return "initial_architect_review";
  if (request.kind === "memory") return "memory_approval";
  if (request.kind === "worktree") return "worktree_launch_approval";
  return "other_approval";
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
  requiredVariants: string[] = [],
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
  for (const variant of requiredVariants) {
    regex.lastIndex = 0;
    if (!regex.test(variant.trim())) {
      throw new Error(
        "Model returned a regex that did not generalize an obvious command selector",
      );
    }
  }
}

function hasHighRiskRegexBacktrackingShape(pattern: string): boolean {
  const groups =
    pattern.match(/\((?:\?:)?(?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/g) ??
    [];
  return groups.some((group) => /\.\*|\.\+/.test(group));
}
