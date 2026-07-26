import type { BrowserGatewaySnapshotState } from "../../BrowserGatewayService";
import type {
  BrowserGatewayBackgroundSummary,
  BrowserGatewayOwnerCheckpoint,
  BrowserGatewayTranscriptMessage,
  BrowserGatewayTranscriptText,
} from "../../dataPlane/protocol";
import type {
  ChatMessage,
  ContentBlock,
  ProjectInfo,
} from "../../../agent/webview/types";

import type { BgSessionInfo } from "../../../shared/types";
import {
  parseBrowserGatewayOwnerInteractionPayload,
  type BrowserGatewayOwnerInteractionPayload,
} from "../../dataPlane/interactionPayload";
export class RelaySnapshotProjector {
  private readonly messageCache = new Map<
    string,
    { revision: number; message: ChatMessage }
  >();
  private helperGenerationId: string | null = null;
  private ownerId: string | null = null;
  private ownerGenerationId: string | null = null;
  private modelCatalogRevision: string | null = null;
  private modelsVersion = 0;

  project(
    checkpoint: BrowserGatewayOwnerCheckpoint,
    interactionPayload: BrowserGatewayOwnerInteractionPayload | null = null,
  ): BrowserGatewaySnapshotState {
    this.bindIdentity(checkpoint);
    const projects = checkpoint.catalog.projects.map(projectInfo);
    const projectsById = new Map(
      projects.map((project) => [project.projectId, project]),
    );
    const sessions = checkpoint.catalog.sessions.map((session) => ({
      id: session.sessionId,
      mode: session.mode,
      model: session.model,
      title: session.title,
      messageCount: session.messageCount,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: session.createdAt,
      lastActiveAt: session.updatedAt,
      ...(resolveProject(session.projectId, projectsById)
        ? { project: resolveProject(session.projectId, projectsById) }
        : {}),
    }));
    const foregroundProject = checkpoint.foreground
      ? resolveForegroundProject(checkpoint, projectsById)
      : null;
    const foreground =
      checkpoint.foreground && foregroundProject
        ? {
            sessionId: checkpoint.foreground.sessionId,
            project: foregroundProject,
            title: checkpoint.foreground.title,
            originalPrompt: checkpoint.foreground.originalPrompt,
            mode: checkpoint.foreground.mode,
            model: checkpoint.foreground.model,
            status: checkpoint.foreground.status,
            interactiveExecutionPhase:
              checkpoint.foreground.interactiveExecutionPhase,
            streaming: checkpoint.foreground.streaming,
            ...(checkpoint.foreground.interrupted !== undefined
              ? { interrupted: checkpoint.foreground.interrupted }
              : {}),
            projectedMessages: this.projectMessages(
              checkpoint.transcript.messages,
            ),
            statusOverride: checkpoint.foreground.statusOverride ?? null,
            thinkingEnabled: checkpoint.foreground.thinkingEnabled ?? true,
            reasoningEffort: checkpoint.foreground.reasoningEffort ?? "high",
            lastInputTokens: checkpoint.foreground.lastInputTokens ?? 0,
            lastOutputTokens: checkpoint.foreground.lastOutputTokens ?? 0,
            lastCacheReadTokens: checkpoint.foreground.lastCacheReadTokens ?? 0,
            estimatedTotalUsed: checkpoint.foreground.estimatedTokens ?? 0,
            messageQueue: checkpoint.ui.queue
              .filter(
                (item) => item.state === "queued" || item.state === "running",
              )
              .map((item) => ({ id: item.itemId, text: item.summary })),
            questionRequest: interactionPayload?.question ?? null,
            detectedQuestion: null,
            todos: checkpoint.ui.todos.map((todo) => ({
              id: todo.itemId,
              content: todo.text,
              activeForm: todo.text,
              status: todo.state,
            })),
            debugInfo: null,
            systemPrompt: null,
            loadedInstructions: null,
            restoringSession: checkpoint.foreground.restoringSession ?? false,
            revertRecoveryNotice:
              checkpoint.foreground.revertRecoveryNotice ?? null,
            ...(checkpoint.foreground.contextBudget
              ? { contextBudget: { ...checkpoint.foreground.contextBudget } }
              : {}),
            ...(checkpoint.foreground.condenseThreshold !== undefined
              ? {
                  condenseThreshold: checkpoint.foreground.condenseThreshold,
                }
              : {}),
            agentWriteApproval:
              checkpoint.foreground.agentWriteApproval ?? "prompt",
            commandApprovalPolicy:
              checkpoint.foreground.commandApprovalPolicy ?? "safe",
            approvalPolicy:
              checkpoint.foreground.approvalPolicy ?? "on-request",
            approvalReviewer: checkpoint.foreground.approvalReviewer ?? "user",
            executionPreset:
              checkpoint.foreground.executionPreset ?? "native-manual",
            configuredCommandApprovalPolicy:
              checkpoint.foreground.configuredCommandApprovalPolicy ?? "safe",
          }
        : null;

    if (checkpoint.modelCatalogRevision !== this.modelCatalogRevision) {
      this.modelCatalogRevision = checkpoint.modelCatalogRevision;
      this.modelsVersion += 1;
    }

    return {
      ui: {
        approval: interactionPayload?.approval ?? null,
        question: interactionPayload?.question ?? null,
        questionProgress: projectQuestionProgress(
          interactionPayload?.questionProgress ?? null,
        ),
        formElicitation: interactionPayload?.formElicitation ?? null,
        urlElicitation: interactionPayload?.urlElicitation ?? null,
        recentEvents: [],
        mcpStatusInfos: [],
      },
      session: {
        projects,
        defaultProjectId: checkpoint.catalog.defaultProjectId,
        repository: projectRepository(checkpoint, projectsById),
        sessions,
        chatWorkspace: checkpoint.catalog.chatWorkspace ?? null,
        foreground,
      },
      background: projectBackground(checkpoint),
      diffs: checkpoint.diffs.map((diff) => ({
        requestId: diff.requestId,
        filePath: diff.filePath,
        operation: diff.operation as "create" | "modify",
        originalPreview: "",
        proposedPreview: "",
        outsideWorkspace: diff.outsideWorkspace,
        createdAt: diff.createdAt,
      })),
      theme: {
        cssVariables: Object.fromEntries(
          checkpoint.theme.variables.map(({ name, value }) => [name, value]),
        ),
        colorScheme: checkpoint.theme.colorScheme,
      },
      modelsVersion: this.modelsVersion,
    };
  }

  private bindIdentity(checkpoint: BrowserGatewayOwnerCheckpoint): void {
    if (
      this.helperGenerationId === checkpoint.helperGenerationId &&
      this.ownerId === checkpoint.ownerId &&
      this.ownerGenerationId === checkpoint.ownerGenerationId
    ) {
      return;
    }
    this.helperGenerationId = checkpoint.helperGenerationId;
    this.ownerId = checkpoint.ownerId;
    this.ownerGenerationId = checkpoint.ownerGenerationId;
    this.modelCatalogRevision = null;
    this.modelsVersion = 0;
    this.messageCache.clear();
  }

  private projectMessages(
    messages: readonly BrowserGatewayTranscriptMessage[],
  ): ChatMessage[] {
    const visibleIds = new Set(messages.map((message) => message.messageId));
    for (const messageId of this.messageCache.keys()) {
      if (!visibleIds.has(messageId)) this.messageCache.delete(messageId);
    }
    return messages.map((message) => {
      const cached = this.messageCache.get(message.messageId);
      if (cached?.revision === message.revision) return cached.message;
      const projected = projectMessage(message);
      this.messageCache.set(message.messageId, {
        revision: message.revision,
        message: projected,
      });
      return projected;
    });
  }
}

export function parseRelayInteractionPayload(
  value: unknown,
  expected: NonNullable<BrowserGatewayOwnerCheckpoint["ui"]["interaction"]>,
): BrowserGatewayOwnerInteractionPayload {
  let payload: BrowserGatewayOwnerInteractionPayload;
  try {
    payload = parseBrowserGatewayOwnerInteractionPayload(value);
  } catch {
    throw new Error("invalid_relay_interaction_detail");
  }
  const question = payload.question;
  const questionProgress = payload.questionProgress;
  if (
    questionProgress !== null &&
    (!hasRequestId(question) ||
      !hasMatchingRequestId(questionProgress, requestId(question)))
  ) {
    throw new Error("invalid_relay_interaction_detail");
  }
  const primary =
    expected.kind === "approval"
      ? payload.approval
      : expected.kind === "question"
        ? question
        : expected.kind === "form"
          ? payload.formElicitation
          : payload.urlElicitation;
  if (!hasMatchingRequestId(primary, expected.requestId)) {
    throw new Error("invalid_relay_interaction_detail");
  }
  return payload;
}

function projectQuestionProgress(
  progress: BrowserGatewayOwnerInteractionPayload["questionProgress"],
): BrowserGatewaySnapshotState["ui"]["questionProgress"] {
  if (!progress) return null;
  return {
    id: progress.id,
    step: progress.step,
    answers: Object.fromEntries(
      Object.entries(progress.answers).map(([key, answer]) => [
        key,
        isStringArray(answer) ? [...answer] : answer,
      ]),
    ),
    notes: { ...progress.notes },
    origin: progress.origin,
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function hasRequestId(value: unknown): value is { id: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string",
  );
}

function requestId(value: { id: string }): string {
  return value.id;
}

function hasMatchingRequestId(value: unknown, requestId: string): boolean {
  return hasRequestId(value) && value.id === requestId;
}

function projectInfo(project: {
  projectId: string;
  displayName: string;
  availability: "available" | "unavailable";
}): ProjectInfo {
  return { ...project };
}

function resolveProject(
  projectId: string | null,
  projects: ReadonlyMap<string, ProjectInfo>,
): ProjectInfo | undefined {
  if (!projectId) return undefined;
  return (
    projects.get(projectId) ?? {
      projectId,
      displayName: projectId,
      availability: "unavailable",
    }
  );
}

function resolveForegroundProject(
  checkpoint: BrowserGatewayOwnerCheckpoint,
  projects: ReadonlyMap<string, ProjectInfo>,
): ProjectInfo | null {
  const session = checkpoint.catalog.sessions.find(
    (candidate) => candidate.sessionId === checkpoint.foreground?.sessionId,
  );
  if (!session) return null;
  if (session.projectId === null) {
    return {
      projectId: `owner:${checkpoint.ownerId}`,
      displayName: "Projectless session",
      availability: "unavailable",
    };
  }
  return resolveProject(session.projectId, projects) ?? null;
}

function projectRepository(
  checkpoint: BrowserGatewayOwnerCheckpoint,
  projects: ReadonlyMap<string, ProjectInfo>,
): BrowserGatewaySnapshotState["session"]["repository"] {
  if (!checkpoint.repository) return null;
  const foregroundSession = checkpoint.catalog.sessions.find(
    (session) => session.sessionId === checkpoint.foreground?.sessionId,
  );
  const candidateProjectId =
    foregroundSession?.projectId ??
    checkpoint.catalog.defaultProjectId ??
    (projects.size === 1 ? projects.keys().next().value : undefined);
  if (!candidateProjectId) return null;
  return {
    projectId: candidateProjectId,
    ...(checkpoint.repository.branch
      ? { branch: checkpoint.repository.branch }
      : {}),
    dirty: checkpoint.repository.dirty,
  };
}

function projectBackground(
  checkpoint: BrowserGatewayOwnerCheckpoint,
): BgSessionInfo[] {
  const sessions = new Map<string, BrowserGatewayBackgroundSummary>();
  for (const session of [...checkpoint.background, ...checkpoint.fleet]) {
    const current = sessions.get(session.sessionId);
    if (!current || current.updatedAt <= session.updatedAt) {
      sessions.set(session.sessionId, session);
    }
  }
  return [...sessions.values()].map((session) => ({
    id: session.sessionId,
    task: session.title,
    status: backgroundStatus(session.status),
    lastActiveAt: session.updatedAt,
  }));
}

function backgroundStatus(status: string): BgSessionInfo["status"] {
  switch (status) {
    case "queued":
    case "streaming":
    case "tool_executing":
    case "awaiting_approval":
    case "idle":
    case "error":
    case "cancelled":
      return status;
    case "failed":
      return "error";
    case "completed":
      return "idle";
    default:
      return "idle";
  }
}

function projectMessage(message: BrowserGatewayTranscriptMessage): ChatMessage {
  return {
    id: message.messageId,
    role: message.role,
    content: transcriptText(message.content),
    timestamp: message.createdAt,
    blocks: message.blocks.flatMap(projectBlock),
    ...(message.badge ? { badge: message.badge } : {}),
    ...(message.isSlashCommand !== undefined
      ? { isSlashCommand: message.isSlashCommand }
      : {}),
    ...(message.slashCommandLabel
      ? { slashCommandLabel: message.slashCommandLabel }
      : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.checkpointId ? { checkpointId: message.checkpointId } : {}),
    ...(message.finalMarker ? { finalMarker: message.finalMarker } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.apiRequest ? { apiRequest: message.apiRequest } : {}),
    ...(message.condenseInfo ? { condenseInfo: message.condenseInfo } : {}),
    ...(message.warningMessage
      ? { warningMessage: message.warningMessage }
      : {}),
    ...(message.warningRetry ? { warningRetry: message.warningRetry } : {}),
  };
}

function projectBlock(
  block: BrowserGatewayTranscriptMessage["blocks"][number],
): ContentBlock[] {
  switch (block.type) {
    case "thinking":
      return [
        {
          type: "thinking",
          id: block.blockId,
          text: transcriptText(block.text),
          complete: block.complete,
        },
      ];
    case "text":
      return [{ type: "text", text: transcriptText(block.text) }];
    case "tool_call":
      return [
        {
          type: "tool_call",
          id: block.toolCallId,
          name: block.name,
          inputJson: "",
          result: "",
          complete: block.complete,
          ...(block.durationMs !== undefined
            ? { durationMs: block.durationMs }
            : {}),
        },
      ];
    case "skill_load":
      return [
        {
          type: "skill_load",
          id: block.blockId,
          inputJson: "",
          result: "",
          complete: block.complete,
          ...(block.skillName ? { skillName: block.skillName } : {}),
          ...(block.durationMs !== undefined
            ? { durationMs: block.durationMs }
            : {}),
        },
      ];
    case "bg_agent":
      return [
        {
          type: "bg_agent",
          sessionId: block.sessionId,
          task: block.task,
          ...(block.resolvedModel
            ? { resolvedModel: block.resolvedModel }
            : {}),
          ...(block.resolvedProvider
            ? { resolvedProvider: block.resolvedProvider }
            : {}),
          ...(block.resolvedMode ? { resolvedMode: block.resolvedMode } : {}),
          ...(block.taskClass ? { taskClass: block.taskClass } : {}),
        },
      ];
    case "bg_agent_result":
      return [
        {
          type: "bg_agent_result",
          sessionId: block.sessionId,
          task: block.task,
          status: block.status,
          ...(block.result ? { resultText: transcriptText(block.result) } : {}),
          ...(block.summary ? { summary: block.summary } : {}),
        },
      ];
    case "question_answer":
      return [{ type: "question_answer", items: block.items }];
    case "pairing_status":
      return [];
  }
}

function transcriptText(text: BrowserGatewayTranscriptText): string {
  return text.kind === "inline" ? text.text : text.preview;
}
