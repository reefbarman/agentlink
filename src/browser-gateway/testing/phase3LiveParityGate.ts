import type { ChatMessage } from "../../agent/webview/types.js";
import type { BrowserGatewaySnapshotState } from "../BrowserGatewayService.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayDataPlaneIdentity,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayTranscriptMessage,
} from "../dataPlane/protocol.js";
import type { BrowserGatewayOwnerProjectionPublication } from "../dataPlane/ownerProjectionAdapter.js";
import { RelaySnapshotProjector } from "../webview/relay/relaySnapshotProjection.js";
import {
  BrowserGatewayRelayProjectionAccumulator,
  compareBrowserGatewayStateEquivalence,
  type BrowserGatewayStateEquivalenceDiff,
} from "./stateEquivalenceOracle.js";

const identity = {
  helperGenerationId: "phase3-live-helper",
  ownerId: "phase3-live-owner",
  ownerGenerationId: "phase3-live-owner-generation",
} satisfies BrowserGatewayDataPlaneIdentity;

const referenceMessageCount =
  BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages;
const longSessionMessageCount = referenceMessageCount * 2 + 50;
const paginationPageSize = 50;

export const PHASE3_LIVE_PARITY_KNOWN_DIFFERENCES =
  [] as const satisfies readonly string[];

export interface Phase3LiveParityBoundary {
  readonly name: string;
  readonly ownerSequence: number;
  readonly projectedMessageCount: number;
  readonly hasEarlier: boolean;
  readonly relayDiffs: readonly BrowserGatewayStateEquivalenceDiff[];
  readonly projectorDiffs: readonly BrowserGatewayStateEquivalenceDiff[];
}

export interface Phase3LiveParityScenario {
  readonly name: "short" | "reference-200" | "long-paginated";
  readonly sourceMessageCount: number;
  readonly boundaries: readonly Phase3LiveParityBoundary[];
  readonly equivalent: boolean;
}

export interface Phase3LiveParityGateReport {
  readonly equivalent: boolean;
  readonly knownDifferences: readonly string[];
  readonly referenceMessageCount: number;
  readonly scenarios: readonly Phase3LiveParityScenario[];
  readonly boundaryCount: number;
}

interface ScenarioHarness {
  readonly accumulator: BrowserGatewayRelayProjectionAccumulator;
  readonly projector: RelaySnapshotProjector;
  legacy: BrowserGatewaySnapshotState;
}

/**
 * Runs the Phase 3 projected-view-model gate against real accumulator and
 * browser projection implementations. Every boundary must independently show:
 * legacy snapshot = accumulated relay checkpoint = projected GatewaySnapshot.
 */
export function runPhase3LiveParityGate(): Phase3LiveParityGateReport {
  const scenarios = [
    runShortScenario(),
    runReferenceScenario(),
    runLongPaginatedScenario(),
  ];
  return {
    equivalent: scenarios.every((scenario) => scenario.equivalent),
    knownDifferences: PHASE3_LIVE_PARITY_KNOWN_DIFFERENCES,
    referenceMessageCount,
    scenarios,
    boundaryCount: scenarios.reduce(
      (total, scenario) => total + scenario.boundaries.length,
      0,
    ),
  };
}

function runShortScenario(): Phase3LiveParityScenario {
  const messages = createMessages(0, 6, true);
  const checkpoint = createCheckpoint(messages, messages.length, false);
  const harness = createHarness(checkpoint, messages);
  const boundaries = [evaluateBoundary(harness, "initial checkpoint")];

  const appended = createMessage(messages.length, "assistant");
  applyEvent(harness, {
    kind: "transcript.message.appended",
    payload: { message: appended },
  });
  appendLegacyMessage(harness.legacy, appended);
  boundaries.push(evaluateBoundary(harness, "message appended"));

  const updated = createMessage(
    messages.length,
    "assistant",
    2,
    "completed response",
  );
  applyEvent(harness, {
    kind: "transcript.message.upserted",
    payload: { message: updated },
  });
  replaceLegacyMessage(harness.legacy, updated);
  boundaries.push(evaluateBoundary(harness, "message upserted"));

  return scenario("short", messages.length + 1, boundaries);
}

function runReferenceScenario(): Phase3LiveParityScenario {
  const messages = createMessages(0, referenceMessageCount, false);
  const checkpoint = createCheckpoint(messages, messages.length, false);
  const harness = createHarness(checkpoint, messages);
  const boundaries = [evaluateBoundary(harness, "200-message checkpoint")];

  const lastIndex = messages.length - 1;
  const updated = createMessage(
    lastIndex,
    "assistant",
    2,
    "reference history updated",
  );
  applyEvent(harness, {
    kind: "transcript.message.upserted",
    payload: { message: updated },
  });
  replaceLegacyMessage(harness.legacy, updated);
  boundaries.push(evaluateBoundary(harness, "reference message upserted"));

  return scenario("reference-200", messages.length, boundaries);
}

function runLongPaginatedScenario(): Phase3LiveParityScenario {
  const latestStart = longSessionMessageCount - paginationPageSize;
  const latest = createMessages(latestStart, longSessionMessageCount, false);
  const checkpoint = createCheckpoint(latest, longSessionMessageCount, true);
  const harness = createHarness(checkpoint, latest);
  const boundaries = [evaluateBoundary(harness, "latest page checkpoint")];

  for (
    let end = latestStart;
    end > longSessionMessageCount - referenceMessageCount;
    end -= paginationPageSize
  ) {
    const start = Math.max(
      longSessionMessageCount - referenceMessageCount,
      end - paginationPageSize,
    );
    const page = createMessages(start, end, false);
    applyEvent(harness, {
      kind: "transcript.history.prepended",
      payload: {
        messages: page,
        earlierCursor: `before:${start}`,
        hasEarlier: start > 0,
      },
    });
    prependLegacyMessages(harness.legacy, page);
    boundaries.push(
      evaluateBoundary(harness, `history page prepended (${start}-${end - 1})`),
    );
  }

  return scenario("long-paginated", longSessionMessageCount, boundaries);
}

function createHarness(
  checkpoint: BrowserGatewayOwnerCheckpoint,
  legacyMessages: readonly BrowserGatewayTranscriptMessage[],
): ScenarioHarness {
  const accumulator = new BrowserGatewayRelayProjectionAccumulator();
  accumulator.apply({ kind: "checkpoint", checkpoint });
  return {
    accumulator,
    projector: new RelaySnapshotProjector(),
    legacy: createLegacySnapshot(checkpoint, legacyMessages),
  };
}

function evaluateBoundary(
  harness: ScenarioHarness,
  name: string,
): Phase3LiveParityBoundary {
  const relay = harness.accumulator.getCheckpoint();
  const relayResult = compareBrowserGatewayStateEquivalence({
    legacy: harness.legacy,
    relay,
    resolveDetail: harness.accumulator.resolveDetail,
  });
  const projected = harness.projector.project(relay);
  const projectorResult = compareBrowserGatewayStateEquivalence({
    legacy: toOracleSnapshot(projected),
    relay,
    resolveDetail: harness.accumulator.resolveDetail,
  });
  return {
    name,
    ownerSequence: relay.checkpointSequence,
    projectedMessageCount: relay.transcript.messages.length,
    hasEarlier: relay.transcript.hasEarlier,
    relayDiffs: relayResult.diffs,
    projectorDiffs: projectorResult.diffs,
  };
}

function applyEvent(
  harness: ScenarioHarness,
  event: Pick<BrowserGatewayOwnerEvent, "kind" | "payload">,
): void {
  const checkpoint = harness.accumulator.getCheckpoint();
  const ownerSequence = checkpoint.checkpointSequence + 1;
  const publication: BrowserGatewayOwnerProjectionPublication = {
    kind: "event",
    event: {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      ...identity,
      ownerSequence,
      eventId: `phase3-live-event-${ownerSequence}`,
      emittedAt: ownerSequence + 1,
      ...event,
    } as BrowserGatewayOwnerEvent,
  };
  harness.accumulator.apply(publication);
}

function scenario(
  name: Phase3LiveParityScenario["name"],
  sourceMessageCount: number,
  boundaries: readonly Phase3LiveParityBoundary[],
): Phase3LiveParityScenario {
  return {
    name,
    sourceMessageCount,
    boundaries,
    equivalent: boundaries.every(
      (boundary) =>
        boundary.relayDiffs.length === 0 &&
        boundary.projectorDiffs.length === 0,
    ),
  };
}

function createCheckpoint(
  messages: readonly BrowserGatewayTranscriptMessage[],
  sourceMessageCount: number,
  hasEarlier: boolean,
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    checkpointId: "phase3-live-checkpoint-0",
    checkpointSequence: 0,
    emittedAt: 1,
    foreground: {
      sessionId: "phase3-live-session",
      title: "Phase 3 live parity",
      mode: "code",
      model: "gpt-5.6-sol",
      status: "streaming",
      streaming: true,
      estimatedTokens: 12_345,
      maximumTokens: 200_000,
    },
    catalog: {
      projects: [
        {
          projectId: "phase3-live-project",
          displayName: "Phase 3 project",
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "phase3-live-session",
          projectId: "phase3-live-project",
          title: "Phase 3 live parity",
          mode: "code",
          model: "gpt-5.6-sol",
          messageCount: sourceMessageCount,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      defaultProjectId: "phase3-live-project",
      foregroundSessionId: "phase3-live-session",
    },
    transcript: {
      messages: structuredClone(messages) as BrowserGatewayTranscriptMessage[],
      earlierCursor: hasEarlier ? `before:${messages[0]?.messageId}` : null,
      hasEarlier,
    },
    ui: {
      interaction: null,
      queue: [
        {
          itemId: "phase3-live-queue",
          summary: "Run parity gate",
          state: "queued",
        },
      ],
      todos: [
        {
          itemId: "phase3-live-todo",
          text: "Comparing projections",
          state: "in_progress",
        },
      ],
      operations: [],
    },
    background: [
      {
        sessionId: "phase3-live-background",
        title: "Parity review",
        status: "streaming",
        updatedAt: 3,
      },
    ],
    fleet: [],
    diffs: [
      {
        requestId: "phase3-live-diff",
        filePath: "src/browser-gateway/testing/phase3LiveParityGate.ts",
        operation: "create",
        outsideWorkspace: false,
        createdAt: 4,
      },
    ],
    repository: {
      revision: "phase3-live-repository-1",
      branch: "feature/phase3-live-parity",
      dirty: true,
      rootLabel: "Phase 3 project",
    },
    theme: {
      revision: "phase3-live-theme-1",
      colorScheme: "dark",
      variables: [
        { name: "--vscode-editor-background", value: "#1e1e1e" },
        { name: "--vscode-foreground", value: "#cccccc" },
      ],
    },
    modelCatalogRevision: "phase3-live-models-1",
    capabilities: [],
  };
}

function createMessages(
  start: number,
  end: number,
  alternateRoles: boolean,
): BrowserGatewayTranscriptMessage[] {
  return Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return createMessage(
      index,
      alternateRoles && index % 2 === 0 ? "user" : "assistant",
    );
  });
}

function createMessage(
  index: number,
  role: BrowserGatewayTranscriptMessage["role"],
  revision = 1,
  text = `history-${index}`,
): BrowserGatewayTranscriptMessage {
  return {
    messageId: `phase3-live-message-${index}`,
    role,
    revision,
    createdAt: index + 10,
    content: { kind: "inline", text: "" },
    blocks: [
      {
        type: "tool_call",
        blockId: `phase3-live-tool-${index}`,
        toolCallId: `phase3-live-tool-${index}`,
        name: "read_file",
        complete: true,
      },
      {
        type: "text",
        blockId: "text-1",
        text: { kind: "inline", text },
      },
    ],
    origin: "vscode",
  };
}

function createLegacySnapshot(
  checkpoint: BrowserGatewayOwnerCheckpoint,
  messages: readonly BrowserGatewayTranscriptMessage[],
): BrowserGatewaySnapshotState {
  const project = checkpoint.catalog.projects[0]!;
  const session = checkpoint.catalog.sessions[0]!;
  const foreground = checkpoint.foreground!;
  return {
    ui: {
      approval: null,
      question: null,
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
      recentEvents: [],
      mcpStatusInfos: [],
    },
    session: {
      projects: [{ ...project }],
      defaultProjectId: checkpoint.catalog.defaultProjectId,
      repository: {
        projectId: project.projectId,
        branch: checkpoint.repository?.branch ?? undefined,
        dirty: checkpoint.repository?.dirty,
      },
      sessions: [
        {
          id: session.sessionId,
          mode: session.mode,
          model: session.model,
          title: session.title,
          messageCount: session.messageCount,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          createdAt: session.createdAt,
          lastActiveAt: session.updatedAt,
          project: { ...project },
        },
      ],
      foreground: {
        sessionId: foreground.sessionId,
        project: { ...project },
        title: foreground.title,
        mode: foreground.mode,
        model: foreground.model,
        status: foreground.status,
        streaming: foreground.streaming,
        projectedMessages: messages.map(projectLegacyMessage),
        statusOverride: null,
        thinkingEnabled: true,
        reasoningEffort: "high",
        lastInputTokens: 0,
        lastOutputTokens: 0,
        lastCacheReadTokens: 0,
        estimatedTotalUsed: foreground.estimatedTokens ?? 0,
        messageQueue: checkpoint.ui.queue.map((item) => ({
          id: item.itemId,
          text: item.summary,
        })),
        questionRequest: null,
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
        restoringSession: false,
        revertRecoveryNotice: null,
        agentWriteApproval: "prompt",
        commandApprovalPolicy: "safe",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        executionPreset: "native-manual",
        configuredCommandApprovalPolicy: "safe",
      },
    },
    background: checkpoint.background.map((background) => ({
      id: background.sessionId,
      task: background.title,
      status: "streaming",
      lastActiveAt: background.updatedAt,
    })),
    diffs: checkpoint.diffs.map((diff) => ({
      requestId: diff.requestId,
      filePath: diff.filePath,
      operation: "create",
      originalPreview: "",
      proposedPreview: "",
      outsideWorkspace: diff.outsideWorkspace,
      createdAt: diff.createdAt,
    })),
    theme: {
      colorScheme: checkpoint.theme.colorScheme,
      cssVariables: Object.fromEntries(
        checkpoint.theme.variables.map(({ name, value }) => [name, value]),
      ),
    },
    modelsVersion: 1,
  };
}

function projectLegacyMessage(
  message: BrowserGatewayTranscriptMessage,
): ChatMessage {
  const blocks: ChatMessage["blocks"] = [];
  for (const block of message.blocks) {
    if (block.type === "tool_call") {
      blocks.push({
        type: "tool_call",
        id: block.toolCallId,
        name: block.name,
        inputJson: "",
        result: "",
        complete: block.complete,
      });
    } else if (block.type === "text" && block.text.kind === "inline") {
      blocks.push({ type: "text", text: block.text.text });
    }
  }
  return {
    id: message.messageId,
    role: message.role,
    content: message.content.kind === "inline" ? message.content.text : "",
    timestamp: message.createdAt,
    blocks,
    ...(message.origin ? { origin: message.origin } : {}),
  };
}

function toOracleSnapshot(
  snapshot: BrowserGatewaySnapshotState,
): BrowserGatewaySnapshotState {
  const foreground = snapshot.session.foreground;
  return {
    ...snapshot,
    ui: {
      ...snapshot.ui,
      recentEvents: [],
      mcpStatusInfos: [],
    },
    session: {
      ...snapshot.session,
      foreground: foreground
        ? {
            ...foreground,
            thinkingEnabled: foreground.thinkingEnabled ?? true,
            reasoningEffort: foreground.reasoningEffort ?? "high",
          }
        : null,
    },
    diffs: snapshot.diffs.map((diff) => ({
      ...diff,
      operation: oracleDiffOperation(diff.operation),
    })),
    modelsVersion: snapshot.modelsVersion ?? 0,
  };
}

function oracleDiffOperation(operation: string): "create" | "modify" {
  if (operation === "create" || operation === "modify") return operation;
  throw new Error("phase3_live_invalid_diff_operation");
}

function appendLegacyMessage(
  legacy: BrowserGatewaySnapshotState,
  message: BrowserGatewayTranscriptMessage,
): void {
  legacy.session.foreground!.projectedMessages.push(
    projectLegacyMessage(message),
  );
}

function prependLegacyMessages(
  legacy: BrowserGatewaySnapshotState,
  messages: readonly BrowserGatewayTranscriptMessage[],
): void {
  legacy.session.foreground!.projectedMessages.unshift(
    ...messages.map(projectLegacyMessage),
  );
}

function replaceLegacyMessage(
  legacy: BrowserGatewaySnapshotState,
  message: BrowserGatewayTranscriptMessage,
): void {
  const messages = legacy.session.foreground!.projectedMessages;
  const index = messages.findIndex(
    (candidate) => candidate.id === message.messageId,
  );
  if (index < 0) throw new Error("phase3_live_legacy_message_missing");
  messages[index] = projectLegacyMessage(message);
}
