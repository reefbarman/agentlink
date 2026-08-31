import type { StructuredQuestionRequest as QuestionRequest } from "@agentlink/protocol/structured-question";
import type {
  ChatMessage,
  TodoItem,
} from "@agentlink/protocol/chat-transcript";
import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import type { CoreCapabilityStatusDto } from "@agentlink/protocol/session";
import { BROWSER_GATEWAY_ASK_AGENT_OWNER_ID } from "../browserGatewayAskAgentSessionStore.js";
import type { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  BrowserGatewayOwnerProjectionAdapter,
  type BrowserGatewayOwnerProjectionDetail,
  type BrowserGatewayOwnerProjectionPublication,
} from "../dataPlane/ownerProjectionAdapter.js";
import type { BrowserGatewayOwnerInteractionPayload } from "../dataPlane/interactionPayload.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "../dataPlane/ownerProjectionSources.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  parseBrowserGatewayOwnerCommand,
  parseBrowserGatewayOwnerCommandAck,
  parseBrowserGatewayOwnerPublicationBatch,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOperationState,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerCommand,
  type BrowserGatewayOwnerCommandKind,
  type BrowserGatewayOwnerPublicationBatch,
} from "../dataPlane/protocol.js";
import type {
  AskAgentControllerPublication,
  AskAgentControllerSnapshot,
} from "./AskAgentController.js";

export const ASK_AGENT_OWNER_COMMAND_CAPABILITIES = Object.freeze([
  "session.select",
  "session.send",
  "session.stop",
  "approval.respond",
  "question.respond",
  "history.load",
] as const satisfies readonly BrowserGatewayOwnerCommandKind[]);

export function askAgentOwnerGenerationId(helperGenerationId: string): string {
  return `browser-gateway:ask-agent:${helperGenerationId}`;
}

export function askAgentOwnerCommandCapabilities(): CoreCapabilityStatusDto[] {
  return ASK_AGENT_OWNER_COMMAND_CAPABILITIES.map((capabilityId) => ({
    capabilityId,
    state: "enabled",
  }));
}

export interface AskAgentOwnerResolvedDetail {
  readonly handle: BrowserGatewayDetailHandle;
  readonly content: Uint8Array;
}

export interface AskAgentOwnerCommandExecutor {
  selectSession(sessionId: string): void | Promise<void>;
  send(params: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly details: readonly AskAgentOwnerResolvedDetail[];
    readonly signal: AbortSignal;
  }): void | Promise<void>;
  stopSession(sessionId: string): void | Promise<void>;
  respondToApproval(params: {
    readonly requestId: string;
    readonly decision: "approve" | "reject";
  }): void | Promise<void>;
  respondToQuestion(params: {
    readonly requestId: string;
    readonly response: unknown;
    readonly signal: AbortSignal;
  }): void | Promise<void>;
  loadHistory(params: { readonly cursor: string; readonly count: number }):
    | {
        readonly messages: readonly ChatMessage[];
        readonly earlierCursor: string | null;
        readonly hasEarlier: boolean;
      }
    | Promise<{
        readonly messages: readonly ChatMessage[];
        readonly earlierCursor: string | null;
        readonly hasEarlier: boolean;
      }>;
}

export interface AskAgentOwnerAdapterOptions {
  readonly helperGenerationId: string;
  readonly ownerRegistry: BrowserGatewayCoreOwnerRegistry;
  readonly executor: AskAgentOwnerCommandExecutor;
  readonly ingestPublication: (
    batch: BrowserGatewayOwnerPublicationBatch,
  ) => void | Promise<void>;
  readonly putDetail: (
    handle: BrowserGatewayDetailHandle,
    content: Uint8Array,
  ) => void;
  readonly getDetail: (params: {
    handleId: string;
    ownerId: string;
    ownerGenerationId: string;
  }) => AskAgentOwnerResolvedDetail | null;
  readonly acknowledge: (
    acknowledgement: ReturnType<typeof parseBrowserGatewayOwnerCommandAck>,
  ) => boolean | void;
  readonly onPublicationError?: (error: unknown) => void;
  readonly now?: () => number;
  readonly createBatchId?: () => string;
  readonly heartbeatIntervalMs?: number;
}

class AskAgentProjectionSources implements BrowserGatewayOwnerProjectionSources {
  private readonly listeners = new Set<
    (source: BrowserGatewayOwnerProjectionSourceKind) => void
  >();
  private snapshot: AskAgentControllerSnapshot | undefined;

  setSnapshot(snapshot: AskAgentControllerSnapshot): void {
    this.snapshot = snapshot;
    for (const source of [
      "sessions",
      "ui",
      "theme",
      "model_catalog",
    ] as const) {
      for (const listener of this.listeners) listener(source);
    }
  }

  capture(): BrowserGatewayOwnerProjectionReadSet {
    const snapshot = this.snapshot;
    if (!snapshot) throw new Error("ask_agent_owner_snapshot_unavailable");
    return snapshotToReadSet(snapshot);
  }

  onDidChange(
    listener: (source: BrowserGatewayOwnerProjectionSourceKind) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.listeners.clear();
    this.snapshot = undefined;
  }
}

export class AskAgentOwnerAdapter {
  readonly ownerId = BROWSER_GATEWAY_ASK_AGENT_OWNER_ID;
  readonly ownerGenerationId: string;
  private readonly now: () => number;
  private readonly createBatchId: () => string;
  private readonly sources = new AskAgentProjectionSources();
  private readonly projection: BrowserGatewayOwnerProjectionAdapter;
  private readonly projectionSubscription: { dispose(): void };
  private readonly commandControllers = new Map<string, AbortController>();
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private publicationTail = Promise.resolve();
  private publicationError: unknown;
  private disposed = false;

  constructor(private readonly options: AskAgentOwnerAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.ownerGenerationId = askAgentOwnerGenerationId(
      options.helperGenerationId,
    );
    let batchSequence = 0;
    this.createBatchId =
      options.createBatchId ??
      (() => `${this.ownerGenerationId}:local-batch:${++batchSequence}`);
    this.projection = new BrowserGatewayOwnerProjectionAdapter(
      this.sources,
      {
        helperGenerationId: options.helperGenerationId,
        ownerId: this.ownerId,
        ownerGenerationId: this.ownerGenerationId,
      },
      { commandCapabilities: ASK_AGENT_OWNER_COMMAND_CAPABILITIES },
    );
    this.projectionSubscription = this.projection.onDidPublish(
      (publication) => {
        this.enqueuePublication(publication);
      },
    );
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimer =
      heartbeatIntervalMs > 0
        ? setInterval(() => this.heartbeat(), heartbeatIntervalMs)
        : undefined;
    this.heartbeatTimer?.unref?.();
  }

  publishControllerPublication(
    publication: AskAgentControllerPublication,
  ): void {
    this.assertOpen();
    this.sources.setSnapshot(publication.snapshot);
  }

  initialize(snapshot: AskAgentControllerSnapshot): void {
    this.assertOpen();
    this.sources.setSnapshot(snapshot);
  }

  setDemanded(demanded: boolean): void {
    this.assertOpen();
    this.projection.setDemanded(demanded);
  }

  getCheckpoint(): BrowserGatewayOwnerCheckpoint {
    this.assertOpen();
    return this.projection.getCheckpoint();
  }

  publishRecoveryCheckpoint(): void {
    this.assertOpen();
    this.enqueuePublication(this.projection.getRecoveryCheckpointPublication());
  }

  publishCommand(value: unknown): boolean {
    if (this.disposed) return false;
    const command = parseBrowserGatewayOwnerCommand(value);
    if (!this.matches(command) || command.deadlineAt <= this.now())
      return false;
    if (this.commandControllers.has(command.operationId)) return true;
    const controller = new AbortController();
    this.commandControllers.set(command.operationId, controller);
    this.acknowledge(command, { state: "accepted" });
    void this.executeCommand(command, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          this.acknowledge(command, { state: "completed" });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        this.acknowledge(command, {
          state: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.commandControllers.delete(command.operationId));
    return true;
  }

  cancelCommand(value: unknown): boolean {
    if (this.disposed) return false;
    const command = parseBrowserGatewayOwnerCommand(value);
    if (!this.matches(command)) return false;
    const controller = this.commandControllers.get(command.operationId);
    if (!controller) return false;
    controller.abort();
    this.commandControllers.delete(command.operationId);
    return true;
  }

  async drain(): Promise<void> {
    await this.publicationTail;
    if (this.publicationError !== undefined) throw this.publicationError;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const controller of this.commandControllers.values())
      controller.abort();
    this.commandControllers.clear();
    await this.publicationTail;
    this.disposed = true;
    this.projectionSubscription.dispose();
    this.projection.dispose();
    this.sources.dispose();
    this.options.ownerRegistry.markDisconnected(this.ownerId);
  }

  private heartbeat(): void {
    if (this.disposed) return;
    this.options.ownerRegistry.heartbeat({
      ownerId: this.ownerId,
      ownerGenerationId: this.ownerGenerationId,
      now: this.now(),
    });
  }

  private async executeCommand(
    command: BrowserGatewayOwnerCommand,
    signal: AbortSignal,
  ): Promise<void> {
    switch (command.command.kind) {
      case "session.select":
        return await this.options.executor.selectSession(
          command.command.sessionId,
        );
      case "session.send":
        return await this.options.executor.send({
          operationId: command.operationId,
          sessionId: command.command.sessionId,
          text: command.command.text,
          details: command.command.detailHandles.map((handle) =>
            this.requireDetail(handle),
          ),
          signal,
        });
      case "session.stop":
        return await this.options.executor.stopSession(
          command.command.sessionId,
        );
      case "approval.respond":
        return await this.options.executor.respondToApproval({
          requestId: command.command.requestId,
          decision: command.command.decision,
        });
      case "question.respond":
        return await this.options.executor.respondToQuestion({
          requestId: command.command.requestId,
          response: parseJsonDetail(
            this.requireDetail(command.command.responseHandle),
          ),
          signal,
        });
      case "history.load": {
        const history = await this.options.executor.loadHistory(
          command.command,
        );
        this.projection.publishTranscriptHistory(
          history.messages,
          history.earlierCursor,
          history.hasEarlier,
        );
        return;
      }
      case "diff.detail":
        throw new Error("ask_agent_command_unsupported");
    }
  }

  private requireDetail(
    handle: BrowserGatewayDetailHandle,
  ): AskAgentOwnerResolvedDetail {
    if (
      handle.helperGenerationId !== this.options.helperGenerationId ||
      handle.ownerId !== this.ownerId ||
      handle.ownerGenerationId !== this.ownerGenerationId ||
      handle.expiresAt <= this.now()
    ) {
      throw new Error("ask_agent_detail_unavailable");
    }
    const detail = this.options.getDetail({
      handleId: handle.handleId,
      ownerId: handle.ownerId,
      ownerGenerationId: handle.ownerGenerationId,
    });
    if (!detail || detail.content.byteLength !== handle.byteLength) {
      throw new Error("ask_agent_detail_unavailable");
    }
    return detail;
  }

  private acknowledge(
    command: BrowserGatewayOwnerCommand,
    terminal: Pick<BrowserGatewayOperationState, "state" | "message">,
  ): void {
    const acknowledgement = parseBrowserGatewayOwnerCommandAck({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      helperGenerationId: this.options.helperGenerationId,
      ownerId: this.ownerId,
      ownerGenerationId: this.ownerGenerationId,
      acknowledgedAt: this.now(),
      operation: {
        operationId: command.operationId,
        kind: command.command.kind,
        state: terminal.state,
        ...(terminal.message ? { message: terminal.message } : {}),
      },
    });
    this.options.acknowledge(acknowledgement);
  }

  private enqueuePublication(
    publication: BrowserGatewayOwnerProjectionPublication,
  ): void {
    const publish = async (): Promise<void> => {
      for (const detail of publication.details ?? []) this.storeDetail(detail);
      const checkpoint =
        publication.kind === "checkpoint" ? publication.checkpoint : null;
      const events = publication.kind === "event" ? [publication.event] : [];
      const sequence =
        publication.kind === "checkpoint"
          ? publication.checkpoint.checkpointSequence
          : publication.event.ownerSequence;
      const batch = parseBrowserGatewayOwnerPublicationBatch({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        helperGenerationId: this.options.helperGenerationId,
        ownerId: this.ownerId,
        ownerGenerationId: this.ownerGenerationId,
        batchId: this.createBatchId(),
        firstSequence: sequence,
        lastSequence: sequence,
        checkpoint,
        events,
      });
      await this.options.ingestPublication(batch);
    };
    const publicationOperation = this.publicationTail.then(publish, publish);
    this.publicationError = undefined;
    this.publicationTail = publicationOperation.then(
      () => undefined,
      (error) => {
        this.publicationError = error;
        this.options.onPublicationError?.(error);
      },
    );
  }

  private storeDetail(detail: BrowserGatewayOwnerProjectionDetail): void {
    this.options.putDetail(detail.handle, detail.content);
  }

  private matches(command: BrowserGatewayOwnerCommand): boolean {
    return (
      command.helperGenerationId === this.options.helperGenerationId &&
      command.ownerId === this.ownerId &&
      command.ownerGenerationId === this.ownerGenerationId
    );
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("ask_agent_owner_adapter_disposed");
  }
}

function snapshotToReadSet(
  snapshot: AskAgentControllerSnapshot,
): BrowserGatewayOwnerProjectionReadSet {
  const foreground = snapshot.session.foreground;
  const messages = structuredClone(
    foreground.projectedMessages,
  ) as ChatMessage[];
  const todos = structuredClone(foreground.todos) as TodoItem[];
  const interactionPayload: BrowserGatewayOwnerInteractionPayload = {
    approval: snapshot.ui.approval
      ? (structuredClone(snapshot.ui.approval) as ApprovalRequest)
      : null,
    question: snapshot.ui.question
      ? (structuredClone(snapshot.ui.question) as QuestionRequest)
      : null,
    questionProgress: snapshot.ui.questionProgress
      ? structuredClone(snapshot.ui.questionProgress)
      : null,
    formElicitation: null,
    urlElicitation: null,
  };
  const interaction = snapshot.ui.approval
    ? {
        requestId: snapshot.ui.approval.id,
        kind: "approval" as const,
        payload: interactionPayload,
      }
    : snapshot.ui.question
      ? {
          requestId: snapshot.ui.question.id,
          kind: "question" as const,
          payload: interactionPayload,
          ...(snapshot.ui.question.backgroundTask
            ? { backgroundTask: snapshot.ui.question.backgroundTask }
            : {}),
          ...(snapshot.ui.questionProgress
            ? { step: snapshot.ui.questionProgress.step }
            : {}),
          totalSteps: snapshot.ui.question.questions.length,
        }
      : null;
  return {
    catalog: {
      projects: [],
      sessions: snapshot.session.sessions.map((session) => ({
        sessionId: session.id,
        projectId: null,
        title: session.title,
        mode: session.mode,
        model: session.model,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.lastActiveAt,
      })),
      defaultProjectId: null,
      foregroundSessionId: foreground.sessionId,
    },
    foreground: {
      sessionId: foreground.sessionId,
      title: foreground.title,
      originalPrompt: messages.find((message) => message.role === "user")
        ?.content,
      mode: foreground.mode,
      model: foreground.model,
      status: foreground.status,
      streaming: foreground.streaming,
      interrupted: false,
      estimatedTokens: foreground.estimatedTotalUsed,
      statusOverride: foreground.statusOverride,
      thinkingEnabled: foreground.thinkingEnabled,
      reasoningEffort: foreground.reasoningEffort,
      lastInputTokens: foreground.lastInputTokens,
      lastOutputTokens: foreground.lastOutputTokens,
      lastCacheReadTokens: foreground.lastCacheReadTokens,
      contextHealth: null,
      condenseThreshold: foreground.condenseThreshold,
      restoringSession: foreground.restoringSession,
      revertRecoveryNotice: foreground.revertRecoveryNotice,
      messages,
      earlierCursor: null,
      hasEarlier: false,
      cursorBeforeMessage: (messageId) => {
        const index = messages.findIndex((message) => message.id === messageId);
        return `${foreground.sessionId}:${Math.max(0, index)}`;
      },
      queue: foreground.messageQueue,
      todos,
    },
    interaction,
    background: [],
    fleet: [],
    diffs: [],
    repository: null,
    theme: snapshot.theme,
    modelCatalogRevision: String(snapshot.modelsVersion),
    mcp: [],
    policies: {
      agentWriteApproval: foreground.agentWriteApproval,
      commandApprovalPolicy: "manual",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
      configuredCommandApprovalPolicy: "manual",
    },
  };
}

function parseJsonDetail(detail: AskAgentOwnerResolvedDetail): unknown {
  if (detail.handle.kind !== "interaction") {
    throw new Error("ask_agent_question_detail_invalid");
  }
  try {
    return JSON.parse(new TextDecoder().decode(detail.content));
  } catch {
    throw new Error("ask_agent_question_detail_invalid");
  }
}
