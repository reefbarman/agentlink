import type {
  ChatMessage,
  ContentBlock,
  TodoItem,
} from "../../agent/webview/types.js";
import { isCoreReasoningEffort } from "../../core/modelCatalog.js";
import { utf8ByteLength } from "../../shared/streamingBaselineMetrics.js";
import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayBackgroundSummary,
  type BrowserGatewayCapabilityStatus,
  type BrowserGatewayDataPlaneIdentity,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayDiffPreview,
  type BrowserGatewayForegroundControlState,
  type BrowserGatewayInteractionState,
  type BrowserGatewayInteractionSummary,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayOwnerEventKind,
  type BrowserGatewayOwnerEventPayload,
  type BrowserGatewayOwnerCommandKind,
  type BrowserGatewayQueueItem,
  type BrowserGatewayRepositoryState,
  type BrowserGatewaySessionCatalog,
  type BrowserGatewayThemeState,
  type BrowserGatewayTodoItem,
  type BrowserGatewayTranscriptBlock,
  type BrowserGatewayTranscriptMessage,
  type BrowserGatewayTranscriptText,
  type BrowserGatewayTranscriptWindow,
  isBrowserGatewaySafeThemeVariable,
  parseBrowserGatewayOwnerCheckpoint,
  parseBrowserGatewayOwnerEvent,
} from "./protocol.js";
import {
  projectBrowserGatewayOwnerInteractionPayload,
  type BrowserGatewayOwnerInteractionPayload,
} from "./interactionPayload.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "./limits.js";
import type { BrowserGatewayDataPlaneFeature } from "../protocol.js";
import type {
  BrowserGatewayOwnerBackgroundSource,
  BrowserGatewayOwnerForegroundSource,
  BrowserGatewayOwnerInteractionSource,
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "./ownerProjectionSources.js";

const MAX_TEXT_PREVIEW_LENGTH = 8_000;
const MAX_SUMMARY_LENGTH = 4_000;
const textEncoder = new TextEncoder();

export interface BrowserGatewayOwnerProjectionDetail {
  readonly handle: BrowserGatewayDetailHandle;
  readonly content: Uint8Array;
}

type BrowserGatewayOwnerProjectionPublicationBase = {
  readonly details?: readonly BrowserGatewayOwnerProjectionDetail[];
};

export type BrowserGatewayOwnerProjectionPublication =
  | (BrowserGatewayOwnerProjectionPublicationBase & {
      kind: "checkpoint";
      checkpoint: BrowserGatewayOwnerCheckpoint;
    })
  | (BrowserGatewayOwnerProjectionPublicationBase & {
      kind: "event";
      event: BrowserGatewayOwnerEvent;
    });

export interface BrowserGatewayOwnerProjectionAdapterOptions {
  now?: () => number;
  createId?: (kind: "checkpoint" | "event", sequence: number) => string;
  createDetailId?: (locator: string, revision: number) => string;
  commandCapabilities?: readonly BrowserGatewayOwnerCommandKind[];
  dataPlaneFeatures?: readonly BrowserGatewayDataPlaneFeature[];
}

interface ProjectionContext {
  readonly detail: (
    text: string,
    locator: string,
  ) => BrowserGatewayTranscriptText;
  readonly interaction: (
    source: BrowserGatewayOwnerInteractionSource | null,
  ) => BrowserGatewayInteractionSummary | null;
  readonly typedBackgroundResults: boolean;
}

interface ProjectedReadSet {
  readonly state: ProjectedOwnerState;
  readonly details: readonly BrowserGatewayOwnerProjectionDetail[];
}

interface CachedProjectionDetail extends BrowserGatewayOwnerProjectionDetail {
  readonly text: string;
}

interface ProjectedOwnerState {
  catalog: BrowserGatewaySessionCatalog;
  foreground: BrowserGatewayForegroundControlState | null;
  transcript: BrowserGatewayTranscriptWindow;
  ui: BrowserGatewayInteractionState;
  background: BrowserGatewayBackgroundSummary[];
  fleet: BrowserGatewayBackgroundSummary[];
  diffs: BrowserGatewayDiffPreview[];
  repository: BrowserGatewayRepositoryState | null;
  theme: BrowserGatewayThemeState;
  modelCatalogRevision: string;
  capabilities: BrowserGatewayCapabilityStatus[];
}

export class BrowserGatewayOwnerProjectionAdapter {
  private readonly listeners = new Set<
    (publication: BrowserGatewayOwnerProjectionPublication) => void
  >();
  private readonly sourceSubscription;
  private readonly now: () => number;
  private readonly createId: (
    kind: "checkpoint" | "event",
    sequence: number,
  ) => string;
  private readonly createDetailId: (
    locator: string,
    revision: number,
  ) => string;
  private readonly detailCache = new Map<string, CachedProjectionDetail>();
  private readonly commandCapabilities: readonly BrowserGatewayOwnerCommandKind[];
  private readonly typedBackgroundResults: boolean;
  private demanded = false;
  private disposed = false;
  private ownerSequence = 0;
  private projected: ProjectedOwnerState | undefined;

  constructor(
    private readonly sources: BrowserGatewayOwnerProjectionSources,
    private readonly identity: BrowserGatewayDataPlaneIdentity,
    options: BrowserGatewayOwnerProjectionAdapterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId =
      options.createId ??
      ((kind, sequence) =>
        `${this.identity.ownerGenerationId}:${kind}:${sequence}:${this.now()}`);
    let nextDetailId = 0;
    this.createDetailId =
      options.createDetailId ??
      ((_locator, revision) =>
        `${this.identity.ownerGenerationId}:message:${++nextDetailId}:${revision}`);
    this.commandCapabilities =
      options.commandCapabilities ??
      (Object.keys(
        BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
      ) as BrowserGatewayOwnerCommandKind[]);
    this.typedBackgroundResults =
      options.dataPlaneFeatures?.includes("typed-background-results-v1") ??
      false;
    this.sourceSubscription = sources.onDidChange((source) => {
      this.handleSourceChange(source);
    });
  }

  onDidPublish(
    listener: (publication: BrowserGatewayOwnerProjectionPublication) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  setDemanded(demanded: boolean): void {
    if (this.disposed || this.demanded === demanded) return;
    if (!demanded) {
      this.demanded = false;
      this.projected = undefined;
      this.detailCache.clear();
      return;
    }
    try {
      const publication = this.createCheckpointPublication(
        this.sources.capture(),
        true,
      );
      this.demanded = true;
      this.publish(publication);
    } catch (error) {
      this.projected = undefined;
      throw error;
    }
  }

  isDemanded(): boolean {
    return this.demanded;
  }

  getCheckpoint(): BrowserGatewayOwnerCheckpoint {
    return this.getCheckpointPublication().checkpoint;
  }

  getCheckpointPublication(): Extract<
    BrowserGatewayOwnerProjectionPublication,
    { kind: "checkpoint" }
  > {
    if (this.disposed) throw new Error("owner projection adapter is disposed");
    return this.createCheckpointPublication(this.sources.capture());
  }

  getRecoveryCheckpointPublication(): Extract<
    BrowserGatewayOwnerProjectionPublication,
    { kind: "checkpoint" }
  > {
    if (this.disposed) throw new Error("owner projection adapter is disposed");
    return this.createCheckpointPublication(this.sources.capture(), true);
  }

  publishTranscriptHistory(
    messages: readonly ChatMessage[],
    earlierCursor: string | null,
    hasEarlier: boolean,
  ): void {
    if (this.disposed) throw new Error("owner projection adapter is disposed");
    const details = new Map<string, BrowserGatewayOwnerProjectionDetail>();
    const projectedMessages = messages.map((message) =>
      projectMessage(message, {
        detail: (text, locator) => this.projectText(text, locator, details),
        interaction: () => null,
        typedBackgroundResults: this.typedBackgroundResults,
      }),
    );
    const referencedDetails = detailsForMessages(
      [...details.values()],
      projectedMessages,
    );
    assertProjectedDetailBudget(referencedDetails);
    this.publishEvent(
      "transcript.history.prepended",
      {
        messages: projectedMessages,
        earlierCursor: earlierCursor ? bounded(earlierCursor, 1_000) : null,
        hasEarlier,
      },
      referencedDetails,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.demanded = false;
    this.projected = undefined;
    this.detailCache.clear();
    this.listeners.clear();
    this.sourceSubscription.dispose();
  }

  private handleSourceChange(
    source: BrowserGatewayOwnerProjectionSourceKind,
  ): void {
    if (this.disposed || !this.demanded) return;
    const readSet = this.sources.capture();
    const previous = this.projected;
    if (!previous) {
      this.publishCheckpoint(readSet);
      return;
    }

    switch (source) {
      case "foreground": {
        const { transcript, details } = this.projectTranscript(
          readSet.foreground,
        );
        const foreground = projectForeground(
          readSet.foreground,
          readSet.policies,
        );
        if (
          previous.foreground?.sessionId !== foreground?.sessionId ||
          !this.publishTranscriptChanges(
            previous.transcript,
            transcript,
            details,
          )
        ) {
          this.publishCheckpoint(readSet);
          return;
        }
        const interactionProjection = this.projectInteraction(
          readSet.interaction,
        );
        const interaction = interactionProjection.interaction;
        const queue = projectQueue(readSet.foreground);
        const todos = projectTodos(readSet.foreground);
        this.publishIfChanged(
          "foreground.control.updated",
          { foreground },
          previous.foreground,
          foreground,
        );
        this.publishIfChanged(
          "interaction.updated",
          { interaction },
          previous.ui.interaction,
          interaction,
          interactionProjection.details,
        );
        this.publishIfChanged(
          "queue.updated",
          { queue },
          previous.ui.queue,
          queue,
        );
        this.publishIfChanged(
          "todo.updated",
          { todos },
          previous.ui.todos,
          todos,
        );
        previous.foreground = foreground;
        previous.transcript = transcript;
        previous.ui = { ...previous.ui, interaction, queue, todos };
        return;
      }
      case "ui": {
        const interactionProjection = this.projectInteraction(
          readSet.interaction,
        );
        const interaction = interactionProjection.interaction;
        this.publishIfChanged(
          "interaction.updated",
          { interaction },
          previous.ui.interaction,
          interaction,
          interactionProjection.details,
        );
        previous.ui = { ...previous.ui, interaction };
        return;
      }
      case "sessions": {
        const { transcript, details } = this.projectTranscript(
          readSet.foreground,
        );
        const foreground = projectForeground(
          readSet.foreground,
          readSet.policies,
        );
        if (
          previous.foreground?.sessionId !== foreground?.sessionId ||
          !this.publishTranscriptChanges(
            previous.transcript,
            transcript,
            details,
          )
        ) {
          this.publishCheckpoint(readSet);
          return;
        }
        const catalog = projectCatalog(readSet);
        this.publishIfChanged(
          "session.catalog.updated",
          { catalog },
          previous.catalog,
          catalog,
        );
        this.publishIfChanged(
          "foreground.control.updated",
          { foreground },
          previous.foreground,
          foreground,
        );
        previous.catalog = catalog;
        previous.foreground = foreground;
        previous.transcript = transcript;
        return;
      }
      case "repository": {
        const repository = projectRepository(readSet);
        this.publishIfChanged(
          "repository.updated",
          { repository },
          previous.repository,
          repository,
        );
        previous.repository = repository;
        return;
      }
      case "background": {
        const sessions = projectBackground(readSet.background);
        this.publishIfChanged(
          "background.updated",
          { sessions },
          previous.background,
          sessions,
        );
        previous.background = sessions;
        return;
      }
      case "fleet": {
        const sessions = projectBackground(readSet.fleet);
        this.publishIfChanged(
          "fleet.updated",
          { sessions },
          previous.fleet,
          sessions,
        );
        previous.fleet = sessions;
        return;
      }
      case "diffs": {
        const diffs = projectDiffs(readSet);
        this.publishIfChanged(
          "diff.preview.updated",
          { diffs },
          previous.diffs,
          diffs,
        );
        previous.diffs = diffs;
        return;
      }
      case "theme": {
        const theme = projectTheme(readSet);
        this.publishIfChanged(
          "theme.updated",
          { theme },
          previous.theme,
          theme,
        );
        previous.theme = theme;
        return;
      }
      case "model_catalog": {
        const revision = bounded(readSet.modelCatalogRevision, 256);
        this.publishIfChanged(
          "model_catalog.revision.updated",
          { revision },
          previous.modelCatalogRevision,
          revision,
        );
        previous.modelCatalogRevision = revision;
        return;
      }
      case "mcp": {
        const capabilities = projectCapabilities(
          readSet,
          this.commandCapabilities,
        );
        this.publishIfChanged(
          "owner.capabilities.updated",
          { capabilities },
          previous.capabilities,
          capabilities,
        );
        previous.capabilities = capabilities;
        return;
      }
      case "policies": {
        const foreground = projectForeground(
          readSet.foreground,
          readSet.policies,
        );
        const capabilities = projectCapabilities(
          readSet,
          this.commandCapabilities,
        );
        this.publishIfChanged(
          "foreground.control.updated",
          { foreground },
          previous.foreground,
          foreground,
        );
        this.publishIfChanged(
          "owner.capabilities.updated",
          { capabilities },
          previous.capabilities,
          capabilities,
        );
        previous.foreground = foreground;
        previous.capabilities = capabilities;
        return;
      }
    }
  }

  private createCheckpointPublication(
    readSet: BrowserGatewayOwnerProjectionReadSet,
    rebaseProjection = false,
  ): Extract<BrowserGatewayOwnerProjectionPublication, { kind: "checkpoint" }> {
    const { state, details } = this.projectReadSet(readSet);
    const checkpoint = parseBrowserGatewayOwnerCheckpoint({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      ...this.identity,
      checkpointId: this.createId("checkpoint", this.ownerSequence),
      checkpointSequence: this.ownerSequence,
      emittedAt: this.now(),
      ...state,
    });
    if (rebaseProjection) this.projected = state;
    return {
      kind: "checkpoint",
      checkpoint,
      ...(details.length > 0 ? { details } : {}),
    };
  }

  private publishCheckpoint(
    readSet: BrowserGatewayOwnerProjectionReadSet,
  ): void {
    this.publish(this.createCheckpointPublication(readSet, true));
  }

  private projectReadSet(
    readSet: BrowserGatewayOwnerProjectionReadSet,
  ): ProjectedReadSet {
    const details = new Map<string, BrowserGatewayOwnerProjectionDetail>();
    const context: ProjectionContext = {
      detail: (text, locator) => this.projectText(text, locator, details),
      interaction: (source) =>
        this.projectInteraction(source, details).interaction,
      typedBackgroundResults: this.typedBackgroundResults,
    };
    const state = projectReadSet(readSet, context, this.commandCapabilities);
    const referencedDetails = [...details.values()];
    assertProjectedDetailBudget(referencedDetails);
    return {
      state,
      details: referencedDetails,
    };
  }

  private projectTranscript(
    foreground: BrowserGatewayOwnerForegroundSource | null,
  ): {
    transcript: BrowserGatewayTranscriptWindow;
    details: readonly BrowserGatewayOwnerProjectionDetail[];
  } {
    const details = new Map<string, BrowserGatewayOwnerProjectionDetail>();
    const transcript = projectTranscript(foreground, {
      detail: (text, locator) => this.projectText(text, locator, details),
      interaction: () => null,
      typedBackgroundResults: this.typedBackgroundResults,
    });
    const referencedDetails = detailsForMessages(
      [...details.values()],
      transcript.messages,
    );
    assertProjectedDetailBudget(referencedDetails);
    return { transcript, details: referencedDetails };
  }

  private projectText(
    text: string,
    locator: string,
    details: Map<string, BrowserGatewayOwnerProjectionDetail>,
  ): BrowserGatewayTranscriptText {
    if (
      utf8ByteLength(text) <=
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerInlineTranscriptTextBytes
    ) {
      return { kind: "inline", text };
    }
    const revision = stableRevision(text);
    let detail = this.detailCache.get(locator);
    if (
      !detail ||
      detail.text !== text ||
      detail.handle.expiresAt <=
        this.now() +
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs / 10
    ) {
      const content = textEncoder.encode(text);
      if (
        content.byteLength >
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes
      ) {
        throw new Error("browser_gateway_transcript_detail_too_large");
      }
      const handleId = this.createDetailId(locator, revision);
      if (!handleId.trim() || handleId.length > 256) {
        throw new Error("browser_gateway_invalid_transcript_detail_handle_id");
      }
      detail = {
        text,
        content,
        handle: {
          ...this.identity,
          handleId,
          kind: "message",
          byteLength: content.byteLength,
          expiresAt:
            this.now() +
            BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs,
          mediaType: "text/plain; charset=utf-8",
        },
      };
      this.detailCache.set(locator, detail);
    }
    details.set(detail.handle.handleId, {
      handle: detail.handle,
      content: detail.content,
    });
    return {
      kind: "detail",
      preview: bounded(text, MAX_TEXT_PREVIEW_LENGTH),
      detailHandle: detail.handle,
    };
  }

  private projectInteraction(
    source: BrowserGatewayOwnerInteractionSource | null,
    targetDetails = new Map<string, BrowserGatewayOwnerProjectionDetail>(),
  ): {
    interaction: BrowserGatewayInteractionSummary | null;
    details: readonly BrowserGatewayOwnerProjectionDetail[];
  } {
    if (!source) return { interaction: null, details: [] };
    const payload = source.payload
      ? projectBrowserGatewayOwnerInteractionPayload(source.payload)
      : null;
    if (!payload || !interactionPayloadMatches(source, payload)) {
      return { interaction: null, details: [] };
    }
    const serialized = JSON.stringify(payload);
    const locator = `interaction:${source.requestId}`;
    let detail = this.detailCache.get(locator);
    if (
      !detail ||
      detail.text !== serialized ||
      detail.handle.kind !== "interaction" ||
      detail.handle.expiresAt <=
        this.now() +
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs / 10
    ) {
      const content = textEncoder.encode(serialized);
      if (
        content.byteLength >
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes
      ) {
        throw new Error("browser_gateway_interaction_detail_too_large");
      }
      const revision = stableRevision(serialized);
      const handleId = this.createDetailId(locator, revision);
      if (!handleId.trim() || handleId.length > 256) {
        throw new Error("browser_gateway_invalid_interaction_detail_handle_id");
      }
      detail = {
        text: serialized,
        handle: {
          ...this.identity,
          handleId,
          kind: "interaction",
          byteLength: content.byteLength,
          expiresAt:
            this.now() +
            BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs,
          mediaType: "application/json; charset=utf-8",
        },
        content,
      };
      this.detailCache.set(locator, detail);
    }
    targetDetails.set(detail.handle.handleId, detail);
    return {
      interaction: projectInteraction(source, detail.handle),
      details: [detail],
    };
  }

  private publishIfChanged(
    kind: BrowserGatewayOwnerEventKind,
    payload: BrowserGatewayOwnerEventPayload,
    previous: unknown,
    next: unknown,
    details: readonly BrowserGatewayOwnerProjectionDetail[] = [],
  ): void {
    if (same(previous, next)) return;
    this.publishEvent(kind, payload, details);
  }

  private publishTranscriptChanges(
    previous: BrowserGatewayTranscriptWindow,
    next: BrowserGatewayTranscriptWindow,
    details: readonly BrowserGatewayOwnerProjectionDetail[],
  ): boolean {
    if (same(previous, next)) return true;
    const previousMessages = previous.messages;
    const nextMessages = next.messages;
    const sameWindowMetadata =
      previous.earlierCursor === next.earlierCursor &&
      previous.hasEarlier === next.hasEarlier;

    if (
      sameWindowMetadata &&
      nextMessages.length > previousMessages.length &&
      previousMessages.every((message, index) =>
        same(message, nextMessages[index]),
      )
    ) {
      for (const message of nextMessages.slice(previousMessages.length)) {
        this.publishEvent(
          "transcript.message.appended",
          { message },
          detailsForMessages(details, [message]),
        );
      }
      return true;
    }

    const prependedCount = nextMessages.length - previousMessages.length;
    if (
      previousMessages.length > 0 &&
      prependedCount > 0 &&
      previousMessages.every((message, index) =>
        same(message, nextMessages[index + prependedCount]),
      )
    ) {
      const messages = nextMessages.slice(0, prependedCount);
      this.publishEvent(
        "transcript.history.prepended",
        {
          messages,
          earlierCursor: next.earlierCursor,
          hasEarlier: next.hasEarlier,
        },
        detailsForMessages(details, messages),
      );
      return true;
    }

    if (
      sameWindowMetadata &&
      previousMessages.length === nextMessages.length &&
      previousMessages.every(
        (message, index) =>
          message.messageId === nextMessages[index]?.messageId,
      )
    ) {
      const changedIndices = previousMessages.flatMap((message, index) =>
        same(message, nextMessages[index]) ? [] : [index],
      );
      if (changedIndices.length !== 1) return false;
      const index = changedIndices[0];
      const previousMessage = previousMessages[index];
      const nextMessage = nextMessages[index];
      const delta = transcriptBlockDelta(previousMessage, nextMessage);
      if (delta) {
        this.publishEvent("transcript.block.delta", delta);
      } else {
        this.publishEvent(
          "transcript.message.upserted",
          { message: nextMessage },
          detailsForMessages(details, [nextMessage]),
        );
      }
      return true;
    }

    return false;
  }

  private publishEvent(
    kind: BrowserGatewayOwnerEventKind,
    payload: BrowserGatewayOwnerEventPayload,
    details: readonly BrowserGatewayOwnerProjectionDetail[] = [],
  ): void {
    const ownerSequence = this.ownerSequence + 1;
    const event = parseBrowserGatewayOwnerEvent({
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      ...this.identity,
      ownerSequence,
      eventId: this.createId("event", ownerSequence),
      kind,
      emittedAt: this.now(),
      payload,
    });
    this.ownerSequence = ownerSequence;
    this.publish({
      kind: "event",
      event,
      ...(details.length > 0 ? { details } : {}),
    });
  }

  private publish(publication: BrowserGatewayOwnerProjectionPublication): void {
    for (const listener of this.listeners) listener(publication);
  }
}

function projectReadSet(
  readSet: BrowserGatewayOwnerProjectionReadSet,
  context: ProjectionContext,
  commandCapabilities: readonly BrowserGatewayOwnerCommandKind[],
): ProjectedOwnerState {
  return {
    catalog: projectCatalog(readSet),
    foreground: projectForeground(readSet.foreground, readSet.policies),
    transcript: projectTranscript(readSet.foreground, context),
    ui: {
      interaction: context.interaction(readSet.interaction),
      queue: projectQueue(readSet.foreground),
      todos: projectTodos(readSet.foreground),
      operations: [],
    },
    background: projectBackground(readSet.background),
    fleet: projectBackground(readSet.fleet),
    diffs: projectDiffs(readSet),
    repository: projectRepository(readSet),
    theme: projectTheme(readSet),
    modelCatalogRevision: bounded(readSet.modelCatalogRevision, 256),
    capabilities: projectCapabilities(readSet, commandCapabilities),
  };
}

function projectCatalog(
  readSet: BrowserGatewayOwnerProjectionReadSet,
): BrowserGatewaySessionCatalog {
  return {
    projects: readSet.catalog.projects.map((project) => ({
      projectId: bounded(project.projectId, 256),
      displayName: bounded(project.displayName, 1_000),
      availability: project.availability,
    })),
    sessions: readSet.catalog.sessions.map((session) => ({
      sessionId: bounded(session.sessionId, 256),
      projectId: session.projectId ? bounded(session.projectId, 256) : null,
      title: bounded(session.title, 1_000),
      mode: bounded(session.mode, 256),
      model: bounded(session.model, 256),
      messageCount: safeInteger(session.messageCount),
      createdAt: safeInteger(session.createdAt),
      updatedAt: safeInteger(session.updatedAt),
    })),
    defaultProjectId: readSet.catalog.defaultProjectId
      ? bounded(readSet.catalog.defaultProjectId, 256)
      : null,
    foregroundSessionId: readSet.catalog.foregroundSessionId
      ? bounded(readSet.catalog.foregroundSessionId, 256)
      : null,
    chatWorkspace: readSet.catalog.chatWorkspace
      ? {
          controllerEpoch: bounded(
            readSet.catalog.chatWorkspace.controllerEpoch,
            256,
          ),
          focusedTabId: bounded(
            readSet.catalog.chatWorkspace.focusedTabId,
            256,
          ),
          tabs: readSet.catalog.chatWorkspace.tabs.map((tab) => ({
            tabId: bounded(tab.tabId, 256),
            displayNumber: Math.max(1, safeInteger(tab.displayNumber)),
            label: bounded(tab.label, 64),
            sessionId: tab.sessionId ? bounded(tab.sessionId, 256) : null,
            placement: tab.placement,
            ...(tab.title ? { title: bounded(tab.title, 1_000) } : {}),
            status: tab.status,
            busy: tab.busy,
            ...(tab.needsAttention !== undefined
              ? { needsAttention: tab.needsAttention }
              : {}),
            ...(tab.mode ? { mode: bounded(tab.mode, 256) } : {}),
            ...(tab.model ? { model: bounded(tab.model, 256) } : {}),
            ...(tab.interactiveExecutionPhase
              ? { interactiveExecutionPhase: tab.interactiveExecutionPhase }
              : {}),
            ...(tab.estimatedTokens !== undefined
              ? { estimatedTokens: safeInteger(tab.estimatedTokens) }
              : {}),
            ...(tab.maximumTokens !== undefined
              ? { maximumTokens: safeInteger(tab.maximumTokens) }
              : {}),
          })),
        }
      : null,
  };
}

function projectForeground(
  foreground: BrowserGatewayOwnerForegroundSource | null,
  policies: BrowserGatewayOwnerProjectionReadSet["policies"],
): BrowserGatewayForegroundControlState | null {
  if (!foreground) return null;
  return {
    sessionId: bounded(foreground.sessionId, 256),
    title: bounded(foreground.title, 1_000),
    ...(foreground.originalPrompt
      ? { originalPrompt: bounded(foreground.originalPrompt, 16_000) }
      : {}),
    mode: bounded(foreground.mode, 128),
    model: bounded(foreground.model, 256),
    status: bounded(foreground.status, 128),
    ...(foreground.interactiveExecutionPhase
      ? { interactiveExecutionPhase: foreground.interactiveExecutionPhase }
      : {}),
    streaming: foreground.streaming,
    ...(foreground.interrupted !== undefined
      ? { interrupted: foreground.interrupted }
      : {}),
    ...(foreground.estimatedTokens !== undefined
      ? { estimatedTokens: safeInteger(foreground.estimatedTokens) }
      : {}),
    ...(foreground.maximumTokens !== undefined
      ? { maximumTokens: safeInteger(foreground.maximumTokens) }
      : {}),
    statusOverride: foreground.statusOverride
      ? bounded(foreground.statusOverride, 4_000)
      : null,
    thinkingEnabled: foreground.thinkingEnabled,
    reasoningEffort: foreground.reasoningEffort,
    lastInputTokens: safeInteger(foreground.lastInputTokens),
    lastOutputTokens: safeInteger(foreground.lastOutputTokens),
    lastCacheReadTokens: safeInteger(foreground.lastCacheReadTokens),
    ...(foreground.contextBudget
      ? {
          contextBudget: {
            contextWindow: safeInteger(foreground.contextBudget.contextWindow),
            maxInputTokens: safeInteger(
              foreground.contextBudget.maxInputTokens,
            ),
            usedInputTokens: safeInteger(
              foreground.contextBudget.usedInputTokens,
            ),
            outputReservation: safeInteger(
              foreground.contextBudget.outputReservation,
            ),
            safetyBufferTokens: safeInteger(
              foreground.contextBudget.safetyBufferTokens,
            ),
            softThresholdBudget: safeInteger(
              foreground.contextBudget.softThresholdBudget,
            ),
            hardBudget: safeInteger(foreground.contextBudget.hardBudget),
          },
        }
      : {}),
    contextHealth: foreground.contextHealth
      ? {
          memory: {
            status: foreground.contextHealth.memory.status,
            retrieval: foreground.contextHealth.memory.retrieval,
            ...(foreground.contextHealth.memory.activeRecordCount !== undefined
              ? {
                  activeRecordCount: safeInteger(
                    foreground.contextHealth.memory.activeRecordCount,
                  ),
                }
              : {}),
            ...(foreground.contextHealth.memory.reason
              ? { reason: bounded(foreground.contextHealth.memory.reason, 240) }
              : {}),
          },
          retrieval: {
            status: foreground.contextHealth.retrieval.status,
            lexical: foreground.contextHealth.retrieval.lexical,
            vector: foreground.contextHealth.retrieval.vector,
            structural: foreground.contextHealth.retrieval.structural,
            ...(foreground.contextHealth.retrieval.sourceCount !== undefined
              ? {
                  sourceCount: safeInteger(
                    foreground.contextHealth.retrieval.sourceCount,
                  ),
                }
              : {}),
            ...(foreground.contextHealth.retrieval.chunkCount !== undefined
              ? {
                  chunkCount: safeInteger(
                    foreground.contextHealth.retrieval.chunkCount,
                  ),
                }
              : {}),
            ...(foreground.contextHealth.retrieval.staleSourceCount !==
            undefined
              ? {
                  staleSourceCount: safeInteger(
                    foreground.contextHealth.retrieval.staleSourceCount,
                  ),
                }
              : {}),
            ...(foreground.contextHealth.retrieval.reason
              ? {
                  reason: bounded(
                    foreground.contextHealth.retrieval.reason,
                    240,
                  ),
                }
              : {}),
          },
          index: {
            status: foreground.contextHealth.index.status,
            state: foreground.contextHealth.index.state,
            ...(foreground.contextHealth.index.current !== undefined
              ? { current: safeInteger(foreground.contextHealth.index.current) }
              : {}),
            ...(foreground.contextHealth.index.total !== undefined
              ? { total: safeInteger(foreground.contextHealth.index.total) }
              : {}),
            ...(foreground.contextHealth.index.totalFilesInIndex !== undefined
              ? {
                  totalFilesInIndex: safeInteger(
                    foreground.contextHealth.index.totalFilesInIndex,
                  ),
                }
              : {}),
            ...(foreground.contextHealth.index.totalChunksInIndex !== undefined
              ? {
                  totalChunksInIndex: safeInteger(
                    foreground.contextHealth.index.totalChunksInIndex,
                  ),
                }
              : {}),
            ...(foreground.contextHealth.index.reason
              ? { reason: bounded(foreground.contextHealth.index.reason, 240) }
              : {}),
          },
        }
      : null,
    ...(foreground.condenseThreshold !== undefined
      ? { condenseThreshold: finiteNonNegative(foreground.condenseThreshold) }
      : {}),
    agentWriteApproval: policies.agentWriteApproval,
    commandApprovalPolicy: policies.commandApprovalPolicy,
    approvalPolicy: policies.approvalPolicy,
    approvalReviewer: policies.approvalReviewer,
    executionPreset: policies.executionPreset,
    configuredCommandApprovalPolicy: policies.configuredCommandApprovalPolicy,
    restoringSession: foreground.restoringSession,
    revertRecoveryNotice: foreground.revertRecoveryNotice
      ? {
          projectId: bounded(foreground.revertRecoveryNotice.projectId, 256),
          checkpointId: bounded(
            foreground.revertRecoveryNotice.checkpointId,
            256,
          ),
          sessionRevision: bounded(
            foreground.revertRecoveryNotice.sessionRevision,
            256,
          ),
          ...(foreground.revertRecoveryNotice.workspaceRevision
            ? {
                workspaceRevision: bounded(
                  foreground.revertRecoveryNotice.workspaceRevision,
                  256,
                ),
              }
            : {}),
          startedAt: finiteNonNegative(
            foreground.revertRecoveryNotice.startedAt,
          ),
          title: bounded(foreground.revertRecoveryNotice.title, 1_000),
          message: bounded(foreground.revertRecoveryNotice.message, 4_000),
        }
      : null,
  };
}

function projectTranscript(
  foreground: BrowserGatewayOwnerForegroundSource | null,
  context: ProjectionContext,
): BrowserGatewayTranscriptWindow {
  if (!foreground)
    return { messages: [], earlierCursor: null, hasEarlier: false };
  const projected = foreground.messages.map((message) =>
    projectMessage(message, context),
  );
  let start = Math.max(
    0,
    projected.length -
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
  );
  let userTurns = 0;
  for (let index = projected.length - 1; index >= start; index -= 1) {
    if (projected[index].role !== "user") continue;
    userTurns += 1;
    if (
      userTurns >
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointUserTurns
    ) {
      start = index + 1;
      break;
    }
  }
  const retained = projected.slice(start);
  return {
    messages: retained,
    earlierCursor:
      start > 0 && retained[0]
        ? bounded(foreground.cursorBeforeMessage(retained[0].messageId), 1_000)
        : foreground.earlierCursor
          ? bounded(foreground.earlierCursor, 1_000)
          : null,
    hasEarlier: foreground.hasEarlier || start > 0,
  };
}

function projectMessage(
  message: ChatMessage,
  context: ProjectionContext,
): BrowserGatewayTranscriptMessage {
  const messageId = bounded(message.id, 256);
  const content = context.detail(message.content, `${messageId}:content`);
  const blocks = message.blocks.flatMap((block, index) => {
    const projected = projectBlock(block, index, messageId, context);
    return projected ? [projected] : [];
  });
  const projected: Omit<BrowserGatewayTranscriptMessage, "revision"> = {
    messageId,
    role: message.role,
    createdAt: finiteNonNegative(message.timestamp),
    content,
    blocks,
    ...(message.badge ? { badge: message.badge } : {}),
    ...(message.isSlashCommand !== undefined
      ? { isSlashCommand: message.isSlashCommand }
      : {}),
    ...(message.slashCommandLabel
      ? { slashCommandLabel: bounded(message.slashCommandLabel, 1_000) }
      : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.checkpointId
      ? { checkpointId: bounded(message.checkpointId, 256) }
      : {}),
    ...(message.finalMarker
      ? {
          finalMarker: {
            status: message.finalMarker.status,
            ...(message.finalMarker.summary
              ? { summary: bounded(message.finalMarker.summary, 8_000) }
              : {}),
            source: message.finalMarker.source,
            ...(message.finalMarker.continueAction
              ? {
                  continueAction: {
                    label: bounded(
                      message.finalMarker.continueAction.label,
                      1_000,
                    ),
                    prompt: bounded(
                      message.finalMarker.continueAction.prompt,
                      8_000,
                    ),
                  },
                }
              : {}),
            ...(message.finalMarker.continueActionConsumed !== undefined
              ? {
                  continueActionConsumed:
                    message.finalMarker.continueActionConsumed,
                }
              : {}),
            ...(message.finalMarker.autoContinueStopReason
              ? {
                  autoContinueStopReason: bounded(
                    message.finalMarker.autoContinueStopReason,
                    4_000,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(message.surfaceChange
      ? {
          surfaceChange: {
            ...(message.surfaceChange.model
              ? {
                  model: {
                    previousModel: bounded(
                      message.surfaceChange.model.previousModel,
                      256,
                    ),
                    model: bounded(message.surfaceChange.model.model, 256),
                  },
                }
              : {}),
            ...(message.surfaceChange.reasoning
              ? { reasoning: { ...message.surfaceChange.reasoning } }
              : {}),
            ...(message.surfaceChange.mode
              ? {
                  mode: {
                    previousMode: bounded(
                      message.surfaceChange.mode.previousMode,
                      128,
                    ),
                    mode: bounded(message.surfaceChange.mode.mode, 128),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(message.error
      ? {
          error: {
            message: bounded(message.error.message, 8_000),
            retryable: message.error.retryable,
            ...(message.error.code
              ? { code: bounded(message.error.code, 256) }
              : {}),
            ...(message.error.actions
              ? {
                  actions: {
                    ...(message.error.actions.signIn !== undefined
                      ? { signIn: message.error.actions.signIn }
                      : {}),
                    ...(message.error.actions.signInAnotherAccount !== undefined
                      ? {
                          signInAnotherAccount:
                            message.error.actions.signInAnotherAccount,
                        }
                      : {}),
                    ...(message.error.actions.condense !== undefined
                      ? { condense: message.error.actions.condense }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(message.apiRequest
      ? {
          apiRequest: {
            requestId: bounded(message.apiRequest.requestId, 256),
            model: bounded(message.apiRequest.model, 256),
            ...(message.apiRequest.reasoningEffort
              ? { reasoningEffort: message.apiRequest.reasoningEffort }
              : {}),
            ...(message.apiRequest.mode
              ? { mode: bounded(message.apiRequest.mode, 256) }
              : {}),
            ...(message.apiRequest.commandApprovalPolicy
              ? {
                  commandApprovalPolicy:
                    message.apiRequest.commandApprovalPolicy,
                }
              : {}),
            inputTokens: safeInteger(message.apiRequest.inputTokens),
            ...(message.apiRequest.uncachedInputTokens !== undefined
              ? {
                  uncachedInputTokens: safeInteger(
                    message.apiRequest.uncachedInputTokens,
                  ),
                }
              : {}),
            ...(message.apiRequest.cacheReadTokens !== undefined
              ? {
                  cacheReadTokens: safeInteger(
                    message.apiRequest.cacheReadTokens,
                  ),
                }
              : {}),
            ...(message.apiRequest.cacheCreationTokens !== undefined
              ? {
                  cacheCreationTokens: safeInteger(
                    message.apiRequest.cacheCreationTokens,
                  ),
                }
              : {}),
            outputTokens: safeInteger(message.apiRequest.outputTokens),
            durationMs: finiteNonNegative(message.apiRequest.durationMs),
            timeToFirstToken: finiteNonNegative(
              message.apiRequest.timeToFirstToken,
            ),
          },
        }
      : {}),
    ...(message.condenseInfo
      ? {
          condenseInfo: {
            prevInputTokens: safeInteger(message.condenseInfo.prevInputTokens),
            newInputTokens: safeInteger(message.condenseInfo.newInputTokens),
            ...(message.condenseInfo.durationMs !== undefined
              ? { durationMs: safeInteger(message.condenseInfo.durationMs) }
              : {}),
            ...(message.condenseInfo.errorMessage
              ? {
                  errorMessage: bounded(
                    message.condenseInfo.errorMessage,
                    8_000,
                  ),
                }
              : {}),
            ...(message.condenseInfo.condensing !== undefined
              ? { condensing: message.condenseInfo.condensing }
              : {}),
            ...(message.condenseInfo.validationWarnings
              ? {
                  validationWarnings:
                    message.condenseInfo.validationWarnings.map((warning) =>
                      bounded(warning, 4_000),
                    ),
                }
              : {}),
          },
        }
      : {}),
    ...(message.warningMessage
      ? { warningMessage: bounded(message.warningMessage, 8_000) }
      : {}),
    ...(message.warningRetry
      ? {
          warningRetry: {
            ...(message.warningRetry.retryDelayMs !== undefined
              ? { retryDelayMs: safeInteger(message.warningRetry.retryDelayMs) }
              : {}),
            ...(message.warningRetry.retryAt !== undefined
              ? { retryAt: safeInteger(message.warningRetry.retryAt) }
              : {}),
            ...(message.warningRetry.retryAttempt !== undefined
              ? { retryAttempt: safeInteger(message.warningRetry.retryAttempt) }
              : {}),
            ...(message.warningRetry.retryMaxAttempts !== undefined
              ? {
                  retryMaxAttempts: safeInteger(
                    message.warningRetry.retryMaxAttempts,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
  return {
    ...projected,
    revision: stableRevision(JSON.stringify(projected)),
  };
}

function projectBlock(
  block: ContentBlock,
  index: number,
  messageId: string,
  context: ProjectionContext,
): BrowserGatewayTranscriptBlock | null {
  switch (block.type) {
    case "thinking":
      return null;
    case "text":
      return {
        type: "text",
        blockId: `text-${index}`,
        text: context.detail(block.text, `${messageId}:block:${index}:text`),
      };
    case "tool_call":
      return {
        type: "tool_call",
        blockId: bounded(block.id, 256),
        toolCallId: bounded(block.id, 256),
        name: bounded(block.name, 1_000),
        complete: block.complete,
        ...(block.durationMs !== undefined
          ? { durationMs: safeInteger(block.durationMs) }
          : {}),
      };
    case "skill_load":
      return {
        type: "skill_load",
        blockId: bounded(block.id, 256),
        ...(block.skillName
          ? { skillName: bounded(block.skillName, 1_000) }
          : {}),
        complete: block.complete,
        ...(block.durationMs !== undefined
          ? { durationMs: safeInteger(block.durationMs) }
          : {}),
      };
    case "bg_agent":
      return {
        type: "bg_agent",
        blockId: `bg-agent-${index}`,
        sessionId: bounded(block.sessionId, 256),
        task: bounded(block.task, 4_000),
        ...(block.resolvedModel
          ? { resolvedModel: bounded(block.resolvedModel, 256) }
          : {}),
        ...(block.resolvedProvider
          ? { resolvedProvider: bounded(block.resolvedProvider, 256) }
          : {}),
        ...(isCoreReasoningEffort(block.reasoningEffort)
          ? { reasoningEffort: block.reasoningEffort }
          : {}),
        ...(block.resolvedMode
          ? { resolvedMode: bounded(block.resolvedMode, 128) }
          : {}),
        ...(block.taskClass
          ? { taskClass: bounded(block.taskClass, 256) }
          : {}),
      };
    case "bg_agent_result":
      return {
        type: "bg_agent_result",
        blockId: `bg-agent-result-${index}`,
        sessionId: bounded(block.sessionId, 256),
        task: bounded(block.task, 4_000),
        status: block.status,
        ...(block.resultText !== undefined ||
        (!context.typedBackgroundResults && block.partialOutput !== undefined)
          ? {
              result: context.detail(
                block.resultText ?? block.partialOutput ?? "",
                `${messageId}:block:${index}:result`,
              ),
            }
          : {}),
        ...(block.summary ? { summary: bounded(block.summary, 4_000) } : {}),
        ...(context.typedBackgroundResults
          ? {
              ...(block.resultState ? { resultState: block.resultState } : {}),
              ...(block.terminalReason
                ? { terminalReason: bounded(block.terminalReason, 4_000) }
                : {}),
              ...(block.partialOutput !== undefined
                ? {
                    partialOutput: context.detail(
                      block.partialOutput,
                      `${messageId}:block:${index}:partial-output`,
                    ),
                  }
                : {}),
              ...(block.retrySafe !== undefined
                ? { retrySafe: block.retrySafe }
                : {}),
              ...(block.agentRetryable !== undefined
                ? { agentRetryable: block.agentRetryable }
                : {}),
            }
          : {}),
      };
    case "question_answer":
      return {
        type: "question_answer",
        blockId: `question-answer-${index}`,
        ...(block.toolCallId ? { toolCallId: block.toolCallId } : {}),
        items: block.items.map((item) => ({
          question: bounded(item.question, 8_000),
          answer: Array.isArray(item.answer)
            ? item.answer.map((answer) => bounded(answer, 8_000))
            : typeof item.answer === "string"
              ? bounded(item.answer, 8_000)
              : item.answer,
          ...(item.note ? { note: bounded(item.note, 4_000) } : {}),
        })),
      };
    case "pairing_code":
      return {
        type: "pairing_status",
        blockId: `pairing-status-${index}`,
        status: block.status,
        expiresAt: finiteNonNegative(block.expiresAt),
        ...(block.deviceLabel
          ? { deviceLabel: bounded(block.deviceLabel, 1_000) }
          : {}),
      };
  }
}

function transcriptBlockDelta(
  previous: BrowserGatewayTranscriptMessage,
  next: BrowserGatewayTranscriptMessage,
): BrowserGatewayOwnerEventPayload | null {
  if (
    previous.messageId !== next.messageId ||
    previous.blocks.length !== next.blocks.length
  ) {
    return null;
  }
  for (let index = 0; index < previous.blocks.length; index += 1) {
    const previousBlock = previous.blocks[index];
    const nextBlock = next.blocks[index];
    if (
      previousBlock.type !== nextBlock.type ||
      previousBlock.blockId !== nextBlock.blockId ||
      (previousBlock.type !== "text" && previousBlock.type !== "thinking") ||
      (nextBlock.type !== "text" && nextBlock.type !== "thinking") ||
      previousBlock.text.kind !== "inline" ||
      nextBlock.text.kind !== "inline" ||
      nextBlock.text.text.length <= previousBlock.text.text.length ||
      !nextBlock.text.text.startsWith(previousBlock.text.text)
    ) {
      continue;
    }
    const candidate = structuredClone(next);
    candidate.revision = previous.revision;
    const candidateBlock = candidate.blocks[index];
    if (candidateBlock.type !== "text" && candidateBlock.type !== "thinking") {
      return null;
    }
    candidateBlock.text = previousBlock.text;
    if (!same(candidate, previous)) return null;
    return {
      messageId: next.messageId,
      blockId: nextBlock.blockId,
      field: nextBlock.type === "thinking" ? "thinking" : "text",
      delta: nextBlock.text.text.slice(previousBlock.text.text.length),
      revision: next.revision,
    };
  }
  return null;
}

function detailsForMessages(
  details: readonly BrowserGatewayOwnerProjectionDetail[],
  messages: readonly BrowserGatewayTranscriptMessage[],
): readonly BrowserGatewayOwnerProjectionDetail[] {
  if (details.length === 0) return [];
  const handles = new Set<string>();
  const visitText = (text: BrowserGatewayTranscriptText): void => {
    if (text.kind === "detail") handles.add(text.detailHandle.handleId);
  };
  for (const message of messages) {
    visitText(message.content);
    for (const block of message.blocks) {
      if (block.type === "text" || block.type === "thinking") {
        visitText(block.text);
      } else if (block.type === "bg_agent_result") {
        if (block.result) visitText(block.result);
        if (block.partialOutput) visitText(block.partialOutput);
      }
    }
  }
  return details.filter((detail) => handles.has(detail.handle.handleId));
}

function assertProjectedDetailBudget(
  details: readonly BrowserGatewayOwnerProjectionDetail[],
): void {
  const totalBytes = details.reduce(
    (sum, detail) => sum + detail.content.byteLength,
    0,
  );
  if (
    totalBytes > BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailStoreBytes
  ) {
    throw new Error("browser_gateway_transcript_detail_budget_exceeded");
  }
}

function projectInteraction(
  source: BrowserGatewayOwnerInteractionSource | null,
  detailHandle?: BrowserGatewayDetailHandle,
): BrowserGatewayInteractionSummary | null {
  if (!source) return null;
  const summary = source.backgroundTask
    ? `${interactionLabel(source.kind)} · ${source.backgroundTask}`
    : interactionLabel(source.kind);
  return {
    requestId: bounded(source.requestId, 256),
    kind: source.kind,
    state: source.step === undefined ? "pending" : "progressed",
    summary: bounded(summary, MAX_SUMMARY_LENGTH),
    ...(source.step !== undefined ? { step: safeInteger(source.step) } : {}),
    ...(source.totalSteps !== undefined
      ? { totalSteps: safeInteger(source.totalSteps) }
      : {}),
    ...(detailHandle ? { detailHandle } : {}),
  };
}

function interactionPayloadMatches(
  source: BrowserGatewayOwnerInteractionSource,
  payload: BrowserGatewayOwnerInteractionPayload,
): boolean {
  if (
    payload.questionProgress &&
    payload.questionProgress.id !== payload.question?.id
  ) {
    return false;
  }
  switch (source.kind) {
    case "approval":
      return payload.approval?.id === source.requestId;
    case "question":
      return payload.question?.id === source.requestId;
    case "form":
      return payload.formElicitation?.id === source.requestId;
    case "url":
      return payload.urlElicitation?.id === source.requestId;
  }
}

function interactionLabel(
  kind: BrowserGatewayOwnerInteractionSource["kind"],
): string {
  switch (kind) {
    case "approval":
      return "Approval required";
    case "question":
      return "Question requires a response";
    case "form":
      return "Form requires a response";
    case "url":
      return "URL confirmation required";
  }
}

function projectQueue(
  foreground: BrowserGatewayOwnerForegroundSource | null,
): BrowserGatewayQueueItem[] {
  return (foreground?.queue ?? []).map((item) => ({
    itemId: bounded(item.id, 256),
    summary: bounded(item.text, MAX_SUMMARY_LENGTH),
    state: "queued",
  }));
}

function projectTodos(
  foreground: BrowserGatewayOwnerForegroundSource | null,
): BrowserGatewayTodoItem[] {
  const result: BrowserGatewayTodoItem[] = [];
  const visit = (todo: TodoItem): void => {
    result.push({
      itemId: bounded(todo.id, 256),
      text: bounded(
        todo.status === "in_progress" ? todo.activeForm : todo.content,
        MAX_SUMMARY_LENGTH,
      ),
      state: todo.status,
    });
    for (const child of todo.children ?? []) visit(child);
  };
  for (const todo of foreground?.todos ?? []) visit(todo);
  return result;
}

function projectBackground(
  sessions: readonly BrowserGatewayOwnerBackgroundSource[],
): BrowserGatewayBackgroundSummary[] {
  return sessions.map((session) => ({
    sessionId: bounded(session.sessionId, 256),
    title: bounded(session.title, 1_000),
    status: bounded(session.status, 128),
    updatedAt: finiteNonNegative(session.updatedAt ?? 0),
  }));
}

function projectDiffs(
  readSet: BrowserGatewayOwnerProjectionReadSet,
): BrowserGatewayDiffPreview[] {
  return readSet.diffs.map((diff) => ({
    requestId: bounded(diff.requestId, 256),
    filePath: bounded(diff.filePath, MAX_SUMMARY_LENGTH),
    operation: bounded(diff.operation, 128),
    outsideWorkspace: diff.outsideWorkspace,
    createdAt: finiteNonNegative(diff.createdAt),
  }));
}

function projectRepository(
  readSet: BrowserGatewayOwnerProjectionReadSet,
): BrowserGatewayRepositoryState | null {
  const repository = readSet.repository;
  if (!repository) return null;
  const project = readSet.catalog.projects.find(
    (candidate) => candidate.projectId === repository.projectId,
  );
  const branch = repository.branch ? bounded(repository.branch, 1_000) : null;
  const dirty = repository.dirty === true;
  return {
    revision: revisionString(
      `${repository.projectId}\u0000${branch ?? ""}\u0000${dirty}`,
    ),
    branch,
    dirty,
    ...(project
      ? { rootLabel: bounded(project.displayName, MAX_SUMMARY_LENGTH) }
      : {}),
  };
}

function projectTheme(
  readSet: BrowserGatewayOwnerProjectionReadSet,
): BrowserGatewayThemeState {
  const variables = Object.entries(readSet.theme.cssVariables)
    .filter(([name, value]) => isBrowserGatewaySafeThemeVariable(name, value))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name: bounded(name, 256),
      value: bounded(value, MAX_SUMMARY_LENGTH),
    }));
  return {
    revision: revisionString(JSON.stringify(variables)),
    colorScheme: readSet.theme.colorScheme ?? "dark",
    variables,
  };
}

function projectCapabilities(
  readSet: BrowserGatewayOwnerProjectionReadSet,
  commandCapabilities: readonly BrowserGatewayOwnerCommandKind[],
): BrowserGatewayCapabilityStatus[] {
  const capabilities: BrowserGatewayCapabilityStatus[] =
    commandCapabilities.map((capabilityId) => ({
      capabilityId,
      state: "enabled",
    }));
  capabilities.push(
    {
      capabilityId: bounded(
        `policy.agent-write.${readSet.policies.agentWriteApproval}`,
        256,
      ),
      state: "enabled",
    },
    {
      capabilityId: bounded(
        `policy.command.${readSet.policies.commandApprovalPolicy}`,
        256,
      ),
      state: "enabled",
    },
    {
      capabilityId: bounded(
        `policy.command-configured.${readSet.policies.configuredCommandApprovalPolicy}`,
        256,
      ),
      state: "enabled",
    },
  );
  for (const server of readSet.mcp) {
    capabilities.push({
      capabilityId: bounded(`mcp.${server.name}`, 256),
      state:
        server.status === "connected"
          ? "enabled"
          : server.status === "disabled"
            ? "disabled"
            : "unavailable",
    });
  }
  return capabilities.sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId),
  );
}

function bounded(value: string, maximumLength: number): string {
  return value.slice(0, maximumLength);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stableRevision(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) + 1;
}

function revisionString(value: string): string {
  return stableRevision(value).toString(36);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
