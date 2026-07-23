import type {
  ChatMessage,
  ContentBlock,
  TodoItem,
} from "../../agent/webview/types.js";
import type { BrowserGatewaySnapshotState } from "../BrowserGatewayService.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import { isBrowserGatewaySafeThemeVariable } from "../dataPlane/protocol.js";
import type {
  BrowserGatewayContextBudget,
  BrowserGatewayDataPlaneIdentity,
  BrowserGatewayDetailHandle,
  BrowserGatewayForegroundControlState,
  BrowserGatewayInteractionSummary,
  BrowserGatewayOwnerCheckpoint,
  BrowserGatewayOwnerEvent,
  BrowserGatewayOperationState,
  BrowserGatewayQueueItem,
  BrowserGatewayRevertRecoveryNotice,
  BrowserGatewaySessionCatalog,
  BrowserGatewayThemeState,
  BrowserGatewayTodoItem,
  BrowserGatewayTranscriptMessage,
  BrowserGatewayTranscriptText,
  BrowserGatewayTranscriptWindow,
} from "../dataPlane/protocol.js";
import type {
  BrowserGatewayOwnerProjectionDetail,
  BrowserGatewayOwnerProjectionPublication,
} from "../dataPlane/ownerProjectionAdapter.js";
import {
  flattenBrowserGatewaySnapshotParityContract,
  type BrowserGatewayFlattenedParityEntry,
} from "../migration/snapshotParityContract.js";

export interface BrowserGatewayStateEquivalenceDiff {
  readonly path: string;
  readonly legacy: unknown;
  readonly relay: unknown;
}

export interface BrowserGatewayStateEquivalenceResult {
  readonly equivalent: boolean;
  readonly cutoverReady: boolean;
  readonly legacy: BrowserGatewayNormalizedSemanticState;
  readonly relay: BrowserGatewayNormalizedSemanticState;
  readonly diffs: readonly BrowserGatewayStateEquivalenceDiff[];
  readonly blockers: readonly BrowserGatewayFlattenedParityEntry[];
}

export interface BrowserGatewayNormalizedSemanticState {
  readonly catalog: {
    readonly projects: readonly {
      readonly projectId: string;
      readonly displayName: string;
      readonly availability: "available" | "unavailable";
    }[];
    readonly sessions: readonly {
      readonly sessionId: string;
      readonly projectId: string | null;
      readonly title: string;
      readonly mode: string;
      readonly model: string;
      readonly messageCount: number;
      readonly createdAt: number;
      readonly updatedAt: number;
    }[];
    readonly defaultProjectId: string | null;
    readonly foregroundSessionId: string | null;
  };
  readonly foreground: {
    readonly sessionId: string;
    readonly title: string;
    readonly mode: string;
    readonly model: string;
    readonly status: string;
    readonly streaming: boolean;
    readonly statusOverride: string | null;
    readonly thinkingEnabled: boolean;
    readonly reasoningEffort: NonNullable<
      BrowserGatewayForegroundControlState["reasoningEffort"]
    >;
    readonly lastInputTokens: number;
    readonly lastOutputTokens: number;
    readonly lastCacheReadTokens: number;
    readonly estimatedTotalUsed: number;
    readonly contextBudget?: BrowserGatewayContextBudget;
    readonly condenseThreshold?: number;
    readonly agentWriteApproval: NonNullable<
      BrowserGatewayForegroundControlState["agentWriteApproval"]
    >;
    readonly commandApprovalPolicy: NonNullable<
      BrowserGatewayForegroundControlState["commandApprovalPolicy"]
    >;
    readonly configuredCommandApprovalPolicy: NonNullable<
      BrowserGatewayForegroundControlState["configuredCommandApprovalPolicy"]
    >;
    readonly restoringSession: boolean;
    readonly revertRecoveryNotice: BrowserGatewayRevertRecoveryNotice | null;
  } | null;
  readonly transcript: readonly BrowserGatewayNormalizedTranscriptMessage[];
  readonly interaction: BrowserGatewayNormalizedInteraction | null;
  readonly queue: readonly BrowserGatewayQueueItem[];
  readonly todos: readonly BrowserGatewayTodoItem[];
  readonly background: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly status: string;
    readonly updatedAt: number;
  }[];
  readonly diffs: readonly {
    readonly requestId: string;
    readonly filePath: string;
    readonly operation: string;
    readonly outsideWorkspace: boolean;
    readonly createdAt: number;
  }[];
  readonly repository: {
    readonly branch: string | null;
    readonly dirty: boolean;
    readonly rootLabel?: string;
  } | null;
  readonly theme: {
    readonly colorScheme: "light" | "dark" | "hc" | "hc-light";
    readonly variables: readonly {
      readonly name: string;
      readonly value: string;
    }[];
  };
}

export interface BrowserGatewayNormalizedInteraction {
  readonly requestId: string;
  readonly kind: BrowserGatewayInteractionSummary["kind"];
  readonly state: "pending" | "progressed" | "cleared";
  readonly summary: string;
  readonly step?: number;
}

export interface BrowserGatewayNormalizedTranscriptMessage {
  readonly messageId: string;
  readonly role: BrowserGatewayTranscriptMessage["role"];
  readonly createdAt: number;
  readonly content: string;
  readonly blocks: readonly BrowserGatewayNormalizedTranscriptBlock[];
  readonly badge?: BrowserGatewayTranscriptMessage["badge"];
  readonly isSlashCommand?: boolean;
  readonly slashCommandLabel?: string;
  readonly origin?: BrowserGatewayTranscriptMessage["origin"];
  readonly checkpointId?: string;
  readonly finalMarker?: BrowserGatewayTranscriptMessage["finalMarker"];
  readonly error?: BrowserGatewayTranscriptMessage["error"];
  readonly apiRequest?: BrowserGatewayTranscriptMessage["apiRequest"];
  readonly condenseInfo?: BrowserGatewayTranscriptMessage["condenseInfo"];
  readonly warningMessage?: string;
  readonly warningRetry?: BrowserGatewayTranscriptMessage["warningRetry"];
}

export type BrowserGatewayNormalizedTranscriptBlock =
  | { readonly type: "text"; readonly blockId: string; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly blockId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly complete: boolean;
      readonly durationMs?: number;
    }
  | {
      readonly type: "skill_load";
      readonly blockId: string;
      readonly skillName?: string;
      readonly complete: boolean;
      readonly durationMs?: number;
    }
  | {
      readonly type: "bg_agent";
      readonly blockId: string;
      readonly sessionId: string;
      readonly task: string;
      readonly resolvedModel?: string;
      readonly resolvedProvider?: string;
      readonly resolvedMode?: string;
      readonly taskClass?: string;
    }
  | {
      readonly type: "bg_agent_result";
      readonly blockId: string;
      readonly sessionId: string;
      readonly task: string;
      readonly status: "completed" | "error" | "cancelled";
      readonly result?: string;
      readonly summary?: string;
    }
  | {
      readonly type: "question_answer";
      readonly blockId: string;
      readonly items: readonly {
        readonly question: string;
        readonly answer: string | string[] | number | boolean | null;
        readonly note?: string;
      }[];
    }
  | {
      readonly type: "pairing_status";
      readonly blockId: string;
      readonly status: "pending" | "consumed" | "expired" | "cancelled";
      readonly expiresAt: number;
      readonly deviceLabel?: string;
    };

export type BrowserGatewayStateEquivalenceDetailResolver = (
  handle: BrowserGatewayDetailHandle,
) => Uint8Array | null;

export function getBrowserGatewayStateEquivalenceBlockers(): BrowserGatewayFlattenedParityEntry[] {
  return flattenBrowserGatewaySnapshotParityContract().filter(
    (entry) => entry.status === "partial" || entry.status === "missing",
  );
}

export function compareBrowserGatewayStateEquivalence(params: {
  legacy: BrowserGatewaySnapshotState;
  relay: BrowserGatewayOwnerCheckpoint;
  resolveDetail?: BrowserGatewayStateEquivalenceDetailResolver;
}): BrowserGatewayStateEquivalenceResult {
  const legacy = normalizeLegacyBrowserGatewaySnapshot(params.legacy);
  const relay = normalizeRelayBrowserGatewayCheckpoint(
    params.relay,
    params.resolveDetail,
  );
  const diffs: BrowserGatewayStateEquivalenceDiff[] = [];
  collectDiffs(legacy, relay, "", diffs);
  const blockers = getBrowserGatewayStateEquivalenceBlockers();
  return {
    equivalent: diffs.length === 0,
    cutoverReady: diffs.length === 0 && blockers.length === 0,
    legacy,
    relay,
    diffs,
    blockers,
  };
}

export function normalizeLegacyBrowserGatewaySnapshot(
  snapshot: BrowserGatewaySnapshotState,
): BrowserGatewayNormalizedSemanticState {
  const foreground = snapshot.session.foreground;
  const projectsById = new Map(
    snapshot.session.projects.map((project) => [project.projectId, project]),
  );
  return {
    catalog: {
      projects: snapshot.session.projects.map((project) => ({ ...project })),
      sessions: snapshot.session.sessions.map((session) => ({
        sessionId: session.id,
        projectId: session.project?.projectId ?? null,
        title: session.title,
        mode: session.mode,
        model: session.model,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.lastActiveAt,
      })),
      defaultProjectId: snapshot.session.defaultProjectId,
      foregroundSessionId: foreground?.sessionId ?? null,
    },
    foreground: foreground
      ? {
          sessionId: foreground.sessionId,
          title: foreground.title,
          mode: foreground.mode,
          model: foreground.model,
          status: foreground.status,
          streaming: foreground.streaming,
          statusOverride: foreground.statusOverride ?? null,
          thinkingEnabled: foreground.thinkingEnabled ?? true,
          reasoningEffort: foreground.reasoningEffort ?? "high",
          lastInputTokens: foreground.lastInputTokens ?? 0,
          lastOutputTokens: foreground.lastOutputTokens ?? 0,
          lastCacheReadTokens: foreground.lastCacheReadTokens ?? 0,
          estimatedTotalUsed: foreground.estimatedTotalUsed ?? 0,
          ...(foreground.contextBudget
            ? { contextBudget: { ...foreground.contextBudget } }
            : {}),
          ...(foreground.condenseThreshold !== undefined
            ? { condenseThreshold: foreground.condenseThreshold }
            : {}),
          agentWriteApproval: foreground.agentWriteApproval ?? "prompt",
          commandApprovalPolicy: foreground.commandApprovalPolicy ?? "safe",
          configuredCommandApprovalPolicy:
            foreground.configuredCommandApprovalPolicy ?? "safe",
          restoringSession: foreground.restoringSession ?? false,
          revertRecoveryNotice: foreground.revertRecoveryNotice
            ? { ...foreground.revertRecoveryNotice }
            : null,
        }
      : null,
    transcript: normalizeLegacyTranscript(foreground?.projectedMessages ?? []),
    interaction: normalizeLegacyInteraction(snapshot),
    queue: (foreground?.messageQueue ?? []).map((item) => ({
      itemId: item.id,
      summary: item.text,
      state: "queued",
    })),
    todos: normalizeLegacyTodos(foreground?.todos ?? []),
    background: snapshot.background.map((session) => ({
      sessionId: session.id,
      title: session.task,
      status: session.status,
      updatedAt: finiteNonNegative(session.lastActiveAt),
    })),
    diffs: snapshot.diffs.map((diff) => ({
      requestId: diff.requestId,
      filePath: diff.filePath,
      operation: diff.operation,
      outsideWorkspace: diff.outsideWorkspace,
      createdAt: diff.createdAt,
    })),
    repository: snapshot.session.repository
      ? {
          branch: snapshot.session.repository.branch ?? null,
          dirty: snapshot.session.repository.dirty === true,
          ...(projectsById.get(snapshot.session.repository.projectId)
            ?.displayName
            ? {
                rootLabel: projectsById.get(
                  snapshot.session.repository.projectId,
                )!.displayName,
              }
            : {}),
        }
      : null,
    theme: normalizeLegacyTheme(snapshot),
  };
}

export function normalizeRelayBrowserGatewayCheckpoint(
  checkpoint: BrowserGatewayOwnerCheckpoint,
  resolveDetail?: BrowserGatewayStateEquivalenceDetailResolver,
): BrowserGatewayNormalizedSemanticState {
  return {
    catalog: normalizeRelayCatalog(checkpoint.catalog),
    foreground: checkpoint.foreground
      ? normalizeRelayForeground(checkpoint.foreground)
      : null,
    transcript: checkpoint.transcript.messages.map((message) =>
      normalizeRelayMessage(message, resolveDetail),
    ),
    interaction: normalizeRelayInteraction(checkpoint.ui.interaction),
    queue: checkpoint.ui.queue.map((item) => ({ ...item })),
    todos: checkpoint.ui.todos.map((item) => ({ ...item })),
    background: checkpoint.background.map((session) => ({ ...session })),
    diffs: checkpoint.diffs.map((diff) => ({
      requestId: diff.requestId,
      filePath: diff.filePath,
      operation: diff.operation,
      outsideWorkspace: diff.outsideWorkspace,
      createdAt: diff.createdAt,
    })),
    repository: checkpoint.repository
      ? {
          branch: checkpoint.repository.branch,
          dirty: checkpoint.repository.dirty,
          ...(checkpoint.repository.rootLabel
            ? { rootLabel: checkpoint.repository.rootLabel }
            : {}),
        }
      : null,
    theme: normalizeRelayTheme(checkpoint.theme),
  };
}

export class BrowserGatewayRelayProjectionAccumulator {
  private checkpoint: BrowserGatewayOwnerCheckpoint | null = null;
  private readonly details = new Map<string, Uint8Array>();

  apply(publication: BrowserGatewayOwnerProjectionPublication): void {
    const publicationIdentity =
      publication.kind === "checkpoint"
        ? publication.checkpoint
        : publication.event;
    const stagedDetails = (publication.details ?? []).map((detail) => {
      if (!sameIdentity(publicationIdentity, detail.handle)) {
        throw new Error("state_equivalence_detail_identity_mismatch");
      }
      return this.validateDetail(detail);
    });
    const applied =
      publication.kind === "checkpoint"
        ? (this.applyCheckpoint(publication.checkpoint), true)
        : this.applyEvent(publication.event);
    if (!applied) return;
    for (const detail of stagedDetails) {
      this.details.set(detail.key, detail.content);
    }
  }

  getCheckpoint(): BrowserGatewayOwnerCheckpoint {
    if (!this.checkpoint)
      throw new Error("state_equivalence_checkpoint_required");
    return structuredClone(this.checkpoint);
  }

  resolveDetail: BrowserGatewayStateEquivalenceDetailResolver = (handle) => {
    const checkpoint = this.checkpoint;
    if (
      !checkpoint ||
      !sameIdentity(checkpoint, handle) ||
      handle.kind !== "message" ||
      handle.mediaType !== "text/plain; charset=utf-8"
    ) {
      return null;
    }
    const content = this.details.get(detailKey(handle));
    if (!content || content.byteLength !== handle.byteLength) return null;
    return content;
  };

  private applyCheckpoint(checkpoint: BrowserGatewayOwnerCheckpoint): void {
    const previous = this.checkpoint;
    if (
      previous &&
      sameIdentity(previous, checkpoint) &&
      checkpoint.checkpointSequence < previous.checkpointSequence
    ) {
      throw new Error("state_equivalence_checkpoint_rollback");
    }
    assertUniqueOwnerState(checkpoint);
    this.checkpoint = structuredClone(checkpoint);
    if (previous && !sameIdentity(previous, checkpoint)) this.details.clear();
  }

  private applyEvent(event: BrowserGatewayOwnerEvent): boolean {
    const current = this.checkpoint;
    if (!current) throw new Error("state_equivalence_checkpoint_required");
    if (!sameIdentity(current, event)) {
      throw new Error("state_equivalence_owner_generation_changed");
    }
    if (event.ownerSequence <= current.checkpointSequence) return false;
    if (event.ownerSequence !== current.checkpointSequence + 1) {
      throw new Error("state_equivalence_sequence_gap");
    }
    const checkpoint = structuredClone(current);
    if (!sameIdentity(checkpoint, event)) {
      throw new Error("state_equivalence_owner_generation_changed");
    }

    switch (event.kind) {
      case "foreground.control.updated":
        checkpoint.foreground = payloadValue(event, "foreground");
        break;
      case "session.catalog.updated":
        checkpoint.catalog = payloadValue(event, "catalog");
        break;
      case "transcript.message.appended": {
        const message = payloadValue<BrowserGatewayTranscriptMessage>(
          event,
          "message",
        );
        if (
          checkpoint.transcript.messages.some(
            (candidate) => candidate.messageId === message.messageId,
          )
        ) {
          throw new Error("state_equivalence_duplicate_message_id");
        }
        assertUniqueBlocks(message);
        checkpoint.transcript.messages.push(message);
        break;
      }
      case "transcript.message.upserted":
        upsertTranscriptMessage(
          checkpoint.transcript,
          payloadValue(event, "message"),
        );
        break;
      case "transcript.block.delta":
        applyTranscriptDelta(checkpoint.transcript, event.payload);
        break;
      case "transcript.history.prepended": {
        const history = event.payload as BrowserGatewayTranscriptWindow;
        assertUnique(history.messages, "messageId", "message");
        const currentIds = new Set(
          checkpoint.transcript.messages.map((message) => message.messageId),
        );
        if (
          history.messages.some((message) => currentIds.has(message.messageId))
        ) {
          throw new Error("state_equivalence_duplicate_message_id");
        }
        for (const message of history.messages) assertUniqueBlocks(message);
        checkpoint.transcript.messages.unshift(
          ...structuredClone(history.messages),
        );
        checkpoint.transcript.earlierCursor = history.earlierCursor;
        checkpoint.transcript.hasEarlier = history.hasEarlier;
        break;
      }
      case "interaction.updated":
        checkpoint.ui.interaction = payloadValue(event, "interaction");
        break;
      case "queue.updated":
        checkpoint.ui.queue = payloadValue(event, "queue");
        break;
      case "todo.updated":
        checkpoint.ui.todos = payloadValue(event, "todos");
        break;
      case "background.updated":
        checkpoint.background = payloadValue(event, "sessions");
        break;
      case "fleet.updated":
        checkpoint.fleet = payloadValue(event, "sessions");
        break;
      case "diff.preview.updated":
        checkpoint.diffs = payloadValue(event, "diffs");
        break;
      case "repository.updated":
        checkpoint.repository = payloadValue(event, "repository");
        break;
      case "theme.updated":
        checkpoint.theme = payloadValue(event, "theme");
        break;
      case "model_catalog.revision.updated":
        checkpoint.modelCatalogRevision = payloadValue(event, "revision");
        break;
      case "owner.capabilities.updated":
        checkpoint.capabilities = payloadValue(event, "capabilities");
        break;
      case "operation.updated": {
        const operation = payloadValue<BrowserGatewayOperationState>(
          event,
          "operation",
        );
        const index = checkpoint.ui.operations.findIndex(
          (candidate) => candidate.operationId === operation.operationId,
        );
        if (index >= 0) checkpoint.ui.operations[index] = operation;
        else checkpoint.ui.operations.push(operation);
        break;
      }
    }
    checkpoint.checkpointSequence = event.ownerSequence;
    checkpoint.emittedAt = event.emittedAt;
    this.checkpoint = checkpoint;
    return true;
  }

  private validateDetail(detail: BrowserGatewayOwnerProjectionDetail): {
    readonly key: string;
    readonly content: Uint8Array;
  } {
    if (detail.content.byteLength !== detail.handle.byteLength) {
      throw new Error("state_equivalence_detail_byte_length_mismatch");
    }
    return {
      key: detailKey(detail.handle),
      content: new Uint8Array(detail.content),
    };
  }
}

function normalizeLegacyTranscript(
  messages: readonly ChatMessage[],
): BrowserGatewayNormalizedTranscriptMessage[] {
  const retained = retainCheckpointMessages(messages);
  return retained.map((message) => ({
    messageId: message.id,
    role: message.role,
    createdAt: message.timestamp,
    content: message.content,
    blocks: message.blocks.flatMap((block, index) => {
      const normalized = normalizeLegacyBlock(block, index);
      return normalized ? [normalized] : [];
    }),
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
    ...(message.apiRequest
      ? {
          apiRequest: {
            requestId: message.apiRequest.requestId,
            model: message.apiRequest.model,
            ...(message.apiRequest.reasoningEffort
              ? { reasoningEffort: message.apiRequest.reasoningEffort }
              : {}),
            inputTokens: message.apiRequest.inputTokens,
            ...(message.apiRequest.uncachedInputTokens !== undefined
              ? { uncachedInputTokens: message.apiRequest.uncachedInputTokens }
              : {}),
            ...(message.apiRequest.cacheReadTokens !== undefined
              ? { cacheReadTokens: message.apiRequest.cacheReadTokens }
              : {}),
            ...(message.apiRequest.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: message.apiRequest.cacheCreationTokens }
              : {}),
            outputTokens: message.apiRequest.outputTokens,
            durationMs: message.apiRequest.durationMs,
            timeToFirstToken: message.apiRequest.timeToFirstToken,
          },
        }
      : {}),
    ...(message.condenseInfo ? { condenseInfo: message.condenseInfo } : {}),
    ...(message.warningMessage
      ? { warningMessage: message.warningMessage }
      : {}),
    ...(message.warningRetry ? { warningRetry: message.warningRetry } : {}),
  }));
}

function normalizeLegacyBlock(
  block: ContentBlock,
  index: number,
): BrowserGatewayNormalizedTranscriptBlock | null {
  switch (block.type) {
    case "thinking":
      return null;
    case "text":
      return { type: "text", blockId: `text-${index}`, text: block.text };
    case "tool_call":
      return {
        type: "tool_call",
        blockId: block.id,
        toolCallId: block.id,
        name: block.name,
        complete: block.complete,
        ...(block.durationMs !== undefined
          ? { durationMs: block.durationMs }
          : {}),
      };
    case "skill_load":
      return {
        type: "skill_load",
        blockId: block.id,
        ...(block.skillName ? { skillName: block.skillName } : {}),
        complete: block.complete,
        ...(block.durationMs !== undefined
          ? { durationMs: block.durationMs }
          : {}),
      };
    case "bg_agent":
      return {
        type: "bg_agent",
        blockId: `bg-agent-${index}`,
        sessionId: block.sessionId,
        task: block.task,
        ...(block.resolvedModel ? { resolvedModel: block.resolvedModel } : {}),
        ...(block.resolvedProvider
          ? { resolvedProvider: block.resolvedProvider }
          : {}),
        ...(block.resolvedMode ? { resolvedMode: block.resolvedMode } : {}),
        ...(block.taskClass ? { taskClass: block.taskClass } : {}),
      };
    case "bg_agent_result":
      return {
        type: "bg_agent_result",
        blockId: `bg-agent-result-${index}`,
        sessionId: block.sessionId,
        task: block.task,
        status: block.status,
        ...(block.resultText !== undefined ? { result: block.resultText } : {}),
        ...(block.summary ? { summary: block.summary } : {}),
      };
    case "question_answer":
      return {
        type: "question_answer",
        blockId: `question-answer-${index}`,
        items: structuredClone(block.items),
      };
    case "pairing_code":
      return {
        type: "pairing_status",
        blockId: `pairing-${index}`,
        status: block.status,
        expiresAt: block.expiresAt,
        ...(block.deviceLabel ? { deviceLabel: block.deviceLabel } : {}),
      };
  }
}

function normalizeRelayMessage(
  message: BrowserGatewayTranscriptMessage,
  resolveDetail?: BrowserGatewayStateEquivalenceDetailResolver,
): BrowserGatewayNormalizedTranscriptMessage {
  const blocks: BrowserGatewayNormalizedTranscriptBlock[] = [];
  for (const block of message.blocks) {
    if (block.type === "thinking") continue;
    if (block.type === "text") {
      blocks.push({
        type: "text",
        blockId: block.blockId,
        text: resolveTranscriptText(block.text, resolveDetail),
      });
      continue;
    }
    if (block.type === "bg_agent_result") {
      blocks.push({
        type: "bg_agent_result",
        blockId: block.blockId,
        sessionId: block.sessionId,
        task: block.task,
        status: block.status,
        ...(block.result
          ? { result: resolveTranscriptText(block.result, resolveDetail) }
          : {}),
        ...(block.summary ? { summary: block.summary } : {}),
      });
      continue;
    }
    blocks.push({ ...block });
  }
  return {
    messageId: message.messageId,
    role: message.role,
    createdAt: message.createdAt,
    content: resolveTranscriptText(message.content, resolveDetail),
    blocks,
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

function resolveTranscriptText(
  text: BrowserGatewayTranscriptText,
  resolveDetail?: BrowserGatewayStateEquivalenceDetailResolver,
): string {
  if (text.kind === "inline") return text.text;
  const content = resolveDetail?.(text.detailHandle);
  if (!content || content.byteLength !== text.detailHandle.byteLength) {
    throw new Error("state_equivalence_detail_unavailable");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function normalizeLegacyInteraction(
  snapshot: BrowserGatewaySnapshotState,
): BrowserGatewayNormalizedInteraction | null {
  const { ui } = snapshot;
  if (ui.approval) {
    const backgroundTask =
      "backgroundTask" in ui.approval &&
      typeof ui.approval.backgroundTask === "string"
        ? ui.approval.backgroundTask
        : undefined;
    return {
      requestId: ui.approval.id,
      kind: "approval",
      state: "pending",
      summary: backgroundTask
        ? `Approval required · ${backgroundTask}`
        : "Approval required",
    };
  }
  if (ui.question) {
    return {
      requestId: ui.question.id,
      kind: "question",
      state: ui.questionProgress ? "progressed" : "pending",
      summary: ui.question.backgroundTask
        ? `Question requires a response · ${ui.question.backgroundTask}`
        : "Question requires a response",
      ...(ui.questionProgress ? { step: ui.questionProgress.step } : {}),
    };
  }
  if (ui.formElicitation) {
    return {
      requestId: ui.formElicitation.id,
      kind: "form",
      state: "pending",
      summary: "Form requires a response",
    };
  }
  if (ui.urlElicitation) {
    return {
      requestId: ui.urlElicitation.id,
      kind: "url",
      state: "pending",
      summary: "URL confirmation required",
    };
  }
  return null;
}

function normalizeRelayInteraction(
  interaction: BrowserGatewayInteractionSummary | null,
): BrowserGatewayNormalizedInteraction | null {
  if (!interaction) return null;
  const questionProgressed =
    interaction.kind === "question" && interaction.step !== undefined;
  return {
    requestId: interaction.requestId,
    kind: interaction.kind,
    state: questionProgressed ? "progressed" : "pending",
    summary: interaction.summary,
    ...(questionProgressed ? { step: interaction.step } : {}),
  };
}

function normalizeLegacyTodos(
  todos: readonly TodoItem[],
): BrowserGatewayTodoItem[] {
  const result: BrowserGatewayTodoItem[] = [];
  const visit = (todo: TodoItem): void => {
    result.push({
      itemId: todo.id,
      text: todo.status === "in_progress" ? todo.activeForm : todo.content,
      state: todo.status,
    });
    for (const child of todo.children ?? []) visit(child);
  };
  for (const todo of todos) visit(todo);
  return result;
}

function normalizeLegacyTheme(
  snapshot: BrowserGatewaySnapshotState,
): BrowserGatewayNormalizedSemanticState["theme"] {
  return {
    colorScheme: snapshot.theme.colorScheme ?? "dark",
    variables: Object.entries(snapshot.theme.cssVariables)
      .filter(([name, value]) => isBrowserGatewaySafeThemeVariable(name, value))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value })),
  };
}

function normalizeRelayTheme(
  theme: BrowserGatewayThemeState,
): BrowserGatewayNormalizedSemanticState["theme"] {
  return {
    colorScheme: theme.colorScheme,
    variables: theme.variables
      .map((variable) => ({ ...variable }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function normalizeRelayCatalog(
  catalog: BrowserGatewaySessionCatalog,
): BrowserGatewayNormalizedSemanticState["catalog"] {
  return {
    projects: catalog.projects.map((project) => ({ ...project })),
    sessions: catalog.sessions.map((session) => ({ ...session })),
    defaultProjectId: catalog.defaultProjectId,
    foregroundSessionId: catalog.foregroundSessionId,
  };
}

function normalizeRelayForeground(
  foreground: BrowserGatewayForegroundControlState,
): NonNullable<BrowserGatewayNormalizedSemanticState["foreground"]> {
  return {
    sessionId: foreground.sessionId,
    title: foreground.title,
    mode: foreground.mode,
    model: foreground.model,
    status: foreground.status,
    streaming: foreground.streaming,
    statusOverride: foreground.statusOverride ?? null,
    thinkingEnabled: foreground.thinkingEnabled ?? true,
    reasoningEffort: foreground.reasoningEffort ?? "high",
    lastInputTokens: foreground.lastInputTokens ?? 0,
    lastOutputTokens: foreground.lastOutputTokens ?? 0,
    lastCacheReadTokens: foreground.lastCacheReadTokens ?? 0,
    estimatedTotalUsed: foreground.estimatedTokens ?? 0,
    ...(foreground.contextBudget
      ? { contextBudget: { ...foreground.contextBudget } }
      : {}),
    ...(foreground.condenseThreshold !== undefined
      ? { condenseThreshold: foreground.condenseThreshold }
      : {}),
    agentWriteApproval: foreground.agentWriteApproval ?? "prompt",
    commandApprovalPolicy: foreground.commandApprovalPolicy ?? "safe",
    configuredCommandApprovalPolicy:
      foreground.configuredCommandApprovalPolicy ?? "safe",
    restoringSession: foreground.restoringSession ?? false,
    revertRecoveryNotice: foreground.revertRecoveryNotice
      ? { ...foreground.revertRecoveryNotice }
      : null,
  };
}

function retainCheckpointMessages(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  let start = Math.max(
    0,
    messages.length -
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
  );
  let userTurns = 0;
  for (let index = messages.length - 1; index >= start; index -= 1) {
    if (messages[index].role !== "user") continue;
    userTurns += 1;
    if (
      userTurns >
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointUserTurns
    ) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start);
}

function upsertTranscriptMessage(
  transcript: BrowserGatewayTranscriptWindow,
  message: BrowserGatewayTranscriptMessage,
): void {
  assertUniqueBlocks(message);
  const index = transcript.messages.findIndex(
    (candidate) => candidate.messageId === message.messageId,
  );
  if (index < 0) {
    transcript.messages.push(message);
    return;
  }
  if (message.revision === transcript.messages[index].revision) {
    throw new Error("state_equivalence_message_revision_unchanged");
  }
  transcript.messages[index] = message;
}

function applyTranscriptDelta(
  transcript: BrowserGatewayTranscriptWindow,
  payload: BrowserGatewayOwnerEvent["payload"],
): void {
  const delta = payload as {
    messageId: string;
    blockId: string;
    field: "text" | "thinking";
    delta: string;
    revision: number;
  };
  const message = transcript.messages.find(
    (candidate) => candidate.messageId === delta.messageId,
  );
  if (!message) throw new Error("state_equivalence_delta_message_missing");
  const block = message.blocks.find(
    (candidate) => candidate.blockId === delta.blockId,
  );
  if (!block || (block.type !== "text" && block.type !== "thinking")) {
    throw new Error("state_equivalence_delta_block_missing");
  }
  if (delta.revision === message.revision) {
    throw new Error("state_equivalence_message_revision_unchanged");
  }
  if (
    (delta.field === "text" && block.type !== "text") ||
    (delta.field === "thinking" && block.type !== "thinking")
  ) {
    throw new Error("state_equivalence_delta_field_mismatch");
  }
  const current = block.text;
  if (current.kind !== "inline") {
    throw new Error("state_equivalence_delta_detail_unsupported");
  }
  block.text = { kind: "inline", text: current.text + delta.delta };
  message.revision = delta.revision;
}

function payloadValue<T>(event: BrowserGatewayOwnerEvent, key: string): T {
  const payload = event.payload as unknown as Record<string, unknown>;
  return structuredClone(payload[key]) as T;
}

function sameIdentity(
  left: BrowserGatewayDataPlaneIdentity,
  right: BrowserGatewayDataPlaneIdentity,
): boolean {
  return (
    left.helperGenerationId === right.helperGenerationId &&
    left.ownerId === right.ownerId &&
    left.ownerGenerationId === right.ownerGenerationId
  );
}

function collectDiffs(
  legacy: unknown,
  relay: unknown,
  path: string,
  diffs: BrowserGatewayStateEquivalenceDiff[],
): void {
  if (Object.is(legacy, relay)) return;
  if (Array.isArray(legacy) && Array.isArray(relay)) {
    const length = Math.max(legacy.length, relay.length);
    for (let index = 0; index < length; index += 1) {
      collectDiffs(
        legacy[index],
        relay[index],
        arrayItemPath(path, legacy[index] ?? relay[index], index),
        diffs,
      );
    }
    return;
  }
  if (isRecord(legacy) && isRecord(relay)) {
    const keys = new Set([...Object.keys(legacy), ...Object.keys(relay)]);
    for (const key of [...keys].sort()) {
      collectDiffs(legacy[key], relay[key], joinPath(path, key), diffs);
    }
    return;
  }
  diffs.push({ path: path || "$", legacy, relay });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinPath(path: string, segment: string): string {
  return path ? `${path}.${segment}` : segment;
}

function arrayItemPath(path: string, value: unknown, index: number): string {
  if (isRecord(value)) {
    for (const key of [
      "messageId",
      "blockId",
      "sessionId",
      "projectId",
      "itemId",
      "requestId",
      "name",
    ] as const) {
      const identifier = value[key];
      if (typeof identifier === "string" && identifier) {
        return `${path}[${identifier}]`;
      }
    }
  }
  return `${path}[${index}]`;
}

function detailKey(handle: BrowserGatewayDetailHandle): string {
  return [
    handle.helperGenerationId,
    handle.ownerId,
    handle.ownerGenerationId,
    handle.handleId,
  ].join("\u0000");
}

function assertUniqueOwnerState(
  checkpoint: BrowserGatewayOwnerCheckpoint,
): void {
  assertUnique(checkpoint.catalog.projects, "projectId", "project");
  assertUnique(checkpoint.catalog.sessions, "sessionId", "session");
  assertUnique(checkpoint.transcript.messages, "messageId", "message");
  assertUnique(checkpoint.ui.queue, "itemId", "queue_item");
  assertUnique(checkpoint.ui.todos, "itemId", "todo_item");
  assertUnique(checkpoint.background, "sessionId", "background_session");
  assertUnique(checkpoint.fleet, "sessionId", "fleet_session");
  assertUnique(checkpoint.diffs, "requestId", "diff");
  for (const message of checkpoint.transcript.messages)
    assertUniqueBlocks(message);
}

function assertUniqueBlocks(message: BrowserGatewayTranscriptMessage): void {
  assertUnique(message.blocks, "blockId", "transcript_block");
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function assertUnique<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
  label: string,
): void {
  const identifiers = new Set<string>();
  for (const value of values) {
    const identifier = value[key];
    if (identifiers.has(identifier)) {
      throw new Error(`state_equivalence_duplicate_${label}_id`);
    }
    identifiers.add(identifier);
  }
}
