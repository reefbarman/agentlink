import type { BackgroundResultState } from "@agentlink/protocol/background-result";
import type { BrowserGatewayBackgroundSummary } from "@agentlink/protocol/browser-gateway-background-summary";
import {
  BROWSER_GATEWAY_CAPABILITY_STATES,
  type BrowserGatewayCapabilityStatus,
} from "@agentlink/protocol/browser-gateway-capability-status";
import type {
  BrowserGatewayChatTabStatus,
  BrowserGatewayChatTabSummary,
  BrowserGatewayChatWorkspaceSummary,
} from "@agentlink/protocol/browser-gateway-chat-workspace-summary";
import type { BrowserGatewayContextBudget } from "@agentlink/protocol/browser-gateway-context-budget";
import type { BrowserGatewayDiffPreview } from "@agentlink/protocol/browser-gateway-diff-preview";
import type {
  BrowserGatewayForegroundControlState,
  BrowserGatewayRevertRecoveryNotice,
} from "@agentlink/protocol/browser-gateway-foreground-control-state";
import type { BrowserGatewayInteractionState } from "@agentlink/protocol/browser-gateway-interaction-state";
import {
  BROWSER_GATEWAY_INTERACTION_KINDS,
  BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES,
  type BrowserGatewayInteractionSummary,
} from "@agentlink/protocol/browser-gateway-interaction-summary";
import {
  BROWSER_GATEWAY_OPERATION_STATUSES,
  type BrowserGatewayOperationState,
} from "@agentlink/protocol/browser-gateway-operation-state";
import type { BrowserGatewayOwnerCheckpoint } from "@agentlink/protocol/browser-gateway-owner-checkpoint";
import type { BrowserGatewayOwnerCommand } from "@agentlink/protocol/browser-gateway-owner-command";
import type { BrowserGatewayOwnerCommandAck } from "@agentlink/protocol/browser-gateway-owner-command-ack";
import type { BrowserGatewayOwnerCommandBody } from "@agentlink/protocol/browser-gateway-owner-command-body";
import {
  BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES,
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES,
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_OWNER_COMMAND_KINDS,
  type BrowserGatewayCommandDeadlineClass,
  type BrowserGatewayCommandIdempotency,
  type BrowserGatewayOwnerCommandKind,
} from "@agentlink/protocol/browser-gateway-owner-command-metadata";
import type { BrowserGatewayOwnerControl } from "@agentlink/protocol/browser-gateway-owner-control";
import {
  BROWSER_GATEWAY_OWNER_CONTROL_KINDS,
  BROWSER_GATEWAY_RELAY_RESET_REASONS,
  type BrowserGatewayOwnerControlKind,
  type BrowserGatewayRelayResetReason,
} from "@agentlink/protocol/browser-gateway-owner-control-metadata";
import type {
  BrowserGatewayOwnerEvent,
  BrowserGatewayOwnerEventPayload,
} from "@agentlink/protocol/browser-gateway-owner-event";
import {
  BROWSER_GATEWAY_OWNER_EVENT_KINDS,
  type BrowserGatewayOwnerEventKind,
} from "@agentlink/protocol/browser-gateway-owner-event-metadata";
import type { BrowserGatewayOwnerPublicationBatch } from "@agentlink/protocol/browser-gateway-owner-publication-batch";
import {
  BROWSER_GATEWAY_QUEUE_ITEM_STATES,
  type BrowserGatewayQueueItem,
} from "@agentlink/protocol/browser-gateway-queue-item";
import type { BrowserGatewayRepositoryState } from "@agentlink/protocol/browser-gateway-repository-state";
import type {
  BrowserGatewayProjectSummary,
  BrowserGatewaySessionCatalog,
  BrowserGatewaySessionSummary,
} from "@agentlink/protocol/browser-gateway-session-catalog";
import type {
  BrowserGatewayChatTabSelection,
  BrowserGatewayOwnerRegistration,
  BrowserGatewayRelayReset,
} from "@agentlink/protocol/browser-gateway-data-plane-transport";
import { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "@agentlink/protocol/browser-gateway-data-plane-version";
import type { BrowserGatewayTranscriptBlock } from "@agentlink/protocol/browser-gateway-transcript-block";
import type { BrowserGatewayTranscriptMessage } from "@agentlink/protocol/browser-gateway-transcript-message";
import type { BrowserGatewayTranscriptText } from "@agentlink/protocol/browser-gateway-transcript-text";
import type { BrowserGatewayTranscriptWindow } from "@agentlink/protocol/browser-gateway-transcript-window";
import {
  BROWSER_GATEWAY_TODO_ITEM_STATES,
  type BrowserGatewayTodoItem,
} from "@agentlink/protocol/browser-gateway-todo-item";
import {
  BROWSER_GATEWAY_COLOR_SCHEMES,
  type BrowserGatewayThemeState,
} from "@agentlink/protocol/browser-gateway-theme";
import {
  BROWSER_GATEWAY_DETAIL_HANDLE_KINDS,
  type BrowserGatewayDataPlaneIdentity,
  type BrowserGatewayDetailHandle,
} from "@agentlink/protocol/browser-gateway-data-plane-identity";
import {
  CORE_REASONING_EFFORTS,
  type CoreReasoningEffort,
} from "@agentlink/protocol/model-catalog";
import {
  BrowserGatewayProtocolError,
  type BrowserGatewayProtocolErrorCode,
} from "@agentlink/protocol/browser-gateway-protocol-error";
import type { ContextHealthSnapshot } from "@agentlink/protocol/context-health";
import { utf8ByteLength } from "../../shared/streamingBaselineMetrics.js";
import {
  BROWSER_GATEWAY_COMMAND_DEADLINE_MS_BY_CLASS,
  BROWSER_GATEWAY_DATA_PLANE_LIMITS,
  browserGatewayDetailResponseByteLimit,
} from "./limits.js";

export type { BrowserGatewayBackgroundSummary } from "@agentlink/protocol/browser-gateway-background-summary";
export type { BrowserGatewayCapabilityStatus } from "@agentlink/protocol/browser-gateway-capability-status";
export type {
  BrowserGatewayChatTabStatus,
  BrowserGatewayChatTabSummary,
  BrowserGatewayChatWorkspaceSummary,
} from "@agentlink/protocol/browser-gateway-chat-workspace-summary";
export type { BrowserGatewayContextBudget } from "@agentlink/protocol/browser-gateway-context-budget";
export type { BrowserGatewayDiffPreview } from "@agentlink/protocol/browser-gateway-diff-preview";
export type {
  BrowserGatewayForegroundControlState,
  BrowserGatewayRevertRecoveryNotice,
} from "@agentlink/protocol/browser-gateway-foreground-control-state";
export type { BrowserGatewayInteractionState } from "@agentlink/protocol/browser-gateway-interaction-state";
export type { BrowserGatewayInteractionSummary } from "@agentlink/protocol/browser-gateway-interaction-summary";
export {
  BROWSER_GATEWAY_OPERATION_STATUSES,
  type BrowserGatewayOperationState,
  type BrowserGatewayOperationStatus,
} from "@agentlink/protocol/browser-gateway-operation-state";
export type { BrowserGatewayOwnerControl } from "@agentlink/protocol/browser-gateway-owner-control";
export {
  BROWSER_GATEWAY_OWNER_CONTROL_KINDS,
  BROWSER_GATEWAY_RELAY_RESET_REASONS,
  type BrowserGatewayOwnerControlKind,
  type BrowserGatewayRelayResetReason,
} from "@agentlink/protocol/browser-gateway-owner-control-metadata";
export type {
  BrowserGatewayOwnerEvent,
  BrowserGatewayOwnerEventPayload,
} from "@agentlink/protocol/browser-gateway-owner-event";
export {
  BROWSER_GATEWAY_OWNER_EVENT_KINDS,
  type BrowserGatewayOwnerEventKind,
} from "@agentlink/protocol/browser-gateway-owner-event-metadata";
export type { BrowserGatewayOwnerPublicationBatch } from "@agentlink/protocol/browser-gateway-owner-publication-batch";
export type { BrowserGatewayOwnerCheckpoint } from "@agentlink/protocol/browser-gateway-owner-checkpoint";
export type { BrowserGatewayOwnerCommand } from "@agentlink/protocol/browser-gateway-owner-command";
export type { BrowserGatewayOwnerCommandAck } from "@agentlink/protocol/browser-gateway-owner-command-ack";
export type { BrowserGatewayOwnerCommandBody } from "@agentlink/protocol/browser-gateway-owner-command-body";
export {
  BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES,
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES,
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_OWNER_COMMAND_KINDS,
  type BrowserGatewayCommandDeadlineClass,
  type BrowserGatewayCommandIdempotency,
  type BrowserGatewayOwnerCommandKind,
} from "@agentlink/protocol/browser-gateway-owner-command-metadata";
export type { BrowserGatewayQueueItem } from "@agentlink/protocol/browser-gateway-queue-item";
export type { BrowserGatewayRepositoryState } from "@agentlink/protocol/browser-gateway-repository-state";
export type {
  BrowserGatewayProjectSummary,
  BrowserGatewaySessionCatalog,
  BrowserGatewaySessionSummary,
} from "@agentlink/protocol/browser-gateway-session-catalog";
export type {
  BrowserGatewayChatTabSelection,
  BrowserGatewayOwnerRegistration,
  BrowserGatewayRelayReset,
} from "@agentlink/protocol/browser-gateway-data-plane-transport";
export { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "@agentlink/protocol/browser-gateway-data-plane-version";
export type { BrowserGatewayTranscriptBlock } from "@agentlink/protocol/browser-gateway-transcript-block";
export type { BrowserGatewayTranscriptMessage } from "@agentlink/protocol/browser-gateway-transcript-message";
export type { BrowserGatewayTranscriptText } from "@agentlink/protocol/browser-gateway-transcript-text";
export type { BrowserGatewayTranscriptWindow } from "@agentlink/protocol/browser-gateway-transcript-window";
export type { BrowserGatewayTodoItem } from "@agentlink/protocol/browser-gateway-todo-item";
export type {
  BrowserGatewayThemeState,
  BrowserGatewayThemeVariable,
} from "@agentlink/protocol/browser-gateway-theme";
export type {
  BrowserGatewayDataPlaneIdentity,
  BrowserGatewayDetailHandle,
} from "@agentlink/protocol/browser-gateway-data-plane-identity";
export {
  BrowserGatewayProtocolError,
  type BrowserGatewayProtocolErrorCode,
} from "@agentlink/protocol/browser-gateway-protocol-error";

const EVENT_KINDS = new Set<string>(BROWSER_GATEWAY_OWNER_EVENT_KINDS);
const COMMAND_KINDS = new Set<string>(BROWSER_GATEWAY_OWNER_COMMAND_KINDS);
const CONTROL_KINDS = new Set<string>(BROWSER_GATEWAY_OWNER_CONTROL_KINDS);
const RESET_REASONS = new Set<string>(BROWSER_GATEWAY_RELAY_RESET_REASONS);

export function parseBrowserGatewayOwnerCheckpoint(
  value: unknown,
): BrowserGatewayOwnerCheckpoint {
  return parseCheckpoint(value, "$", true);
}

export function parseBrowserGatewayOwnerEvent(
  value: unknown,
): BrowserGatewayOwnerEvent {
  return parseEvent(value, "$");
}

export function parseBrowserGatewayDetailHandle(
  value: unknown,
): BrowserGatewayDetailHandle {
  return parseDetailHandle(value, "$");
}

export function parseBrowserGatewayChatTabSelection(
  value: unknown,
): BrowserGatewayChatTabSelection {
  const object = strictRecord(value, "$", ["instanceId", "tabId", "sessionId"]);
  return {
    instanceId: nonEmptyString(object.instanceId, "$.instanceId", 256),
    tabId: nonEmptyString(object.tabId, "$.tabId", 256),
    sessionId:
      object.sessionId === null
        ? null
        : nonEmptyString(object.sessionId, "$.sessionId", 256),
  };
}

export function parseBrowserGatewayOwnerPublicationBatch(
  value: unknown,
): BrowserGatewayOwnerPublicationBatch {
  assertSerializedLimit(
    value,
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes,
    "$",
    "publication request",
  );
  const object = strictRecord(value, "$", [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "batchId",
    "firstSequence",
    "lastSequence",
    "checkpoint",
    "events",
  ]);
  const identity = parseIdentity(object, "$");
  const firstSequence = nonNegativeSafeInteger(
    object.firstSequence,
    "$.firstSequence",
  );
  const lastSequence = nonNegativeSafeInteger(
    object.lastSequence,
    "$.lastSequence",
  );
  if (lastSequence < firstSequence) {
    fail(
      "sequence_mismatch",
      "$.lastSequence",
      "must not precede firstSequence",
    );
  }
  const checkpoint =
    object.checkpoint === null
      ? null
      : parseCheckpoint(object.checkpoint, "$.checkpoint", true);
  assertPublicationEnvelopeLimit(object, checkpoint);
  const events = arrayValue(object.events, "$.events").map((event, index) =>
    parseEvent(event, `$.events[${index}]`),
  );
  if (!checkpoint && events.length === 0) {
    fail("invalid_value", "$", "batch must contain a checkpoint or events");
  }
  assertIdentity(identity, checkpoint, "$.checkpoint");
  events.forEach((event, index) =>
    assertIdentity(identity, event, `$.events[${index}]`),
  );
  if (events.length > 0) {
    if (events[0].ownerSequence !== firstSequence) {
      fail(
        "sequence_mismatch",
        "$.firstSequence",
        "does not match first event",
      );
    }
    if (events.at(-1)?.ownerSequence !== lastSequence) {
      fail("sequence_mismatch", "$.lastSequence", "does not match last event");
    }
    for (let index = 1; index < events.length; index += 1) {
      if (events[index].ownerSequence !== events[index - 1].ownerSequence + 1) {
        fail(
          "sequence_mismatch",
          `$.events[${index}].ownerSequence`,
          "events must be contiguous",
        );
      }
    }
    if (checkpoint && checkpoint.checkpointSequence + 1 !== firstSequence) {
      fail(
        "sequence_mismatch",
        "$.checkpoint.checkpointSequence",
        "must immediately precede batched events",
      );
    }
  } else if (
    checkpoint &&
    (firstSequence !== checkpoint.checkpointSequence ||
      lastSequence !== checkpoint.checkpointSequence)
  ) {
    fail(
      "sequence_mismatch",
      "$",
      "checkpoint-only batch range must equal checkpointSequence",
    );
  }
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      "$.protocolVersion",
    ),
    ...identity,
    batchId: nonEmptyString(object.batchId, "$.batchId", 256),
    firstSequence,
    lastSequence,
    checkpoint,
    events,
  };
}

export function parseBrowserGatewayOwnerControl(
  value: unknown,
): BrowserGatewayOwnerControl {
  assertControlEnvelopeLimit(value, "owner control");
  const object = strictRecord(value, "$", [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "kind",
    "emittedAt",
    "payload",
  ]);
  const kind = enumValue(
    object.kind,
    "$.kind",
    CONTROL_KINDS,
    "unsupported_kind",
  ) as BrowserGatewayOwnerControlKind;
  const payload = strictRecord(
    object.payload,
    "$.payload",
    controlPayloadFields(kind),
  );
  const base = {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      "$.protocolVersion",
    ),
    ...parseIdentity(object, "$"),
    emittedAt: nonNegativeSafeInteger(object.emittedAt, "$.emittedAt"),
  };
  switch (kind) {
    case "hello":
      return {
        ...base,
        kind,
        payload: {
          publicationCursor: nonNegativeSafeInteger(
            payload.publicationCursor,
            "$.payload.publicationCursor",
          ),
          subscriberCount: nonNegativeSafeInteger(
            payload.subscriberCount,
            "$.payload.subscriberCount",
          ),
        },
      };
    case "demand.changed":
      return {
        ...base,
        kind,
        payload: {
          subscriberCount: nonNegativeSafeInteger(
            payload.subscriberCount,
            "$.payload.subscriberCount",
          ),
        },
      };
    case "checkpoint.requested":
      return {
        ...base,
        kind,
        payload: {
          reason: enumValue(
            payload.reason,
            "$.payload.reason",
            new Set([
              "sequence_gap",
              "subscription_changed",
              "checkpoint_required",
            ]),
          ) as "sequence_gap" | "subscription_changed" | "checkpoint_required",
          latestSequence: nonNegativeSafeInteger(
            payload.latestSequence,
            "$.payload.latestSequence",
          ),
        },
      };
    case "command.cancelled":
      return {
        ...base,
        kind,
        payload: {
          operationId: nonEmptyString(
            payload.operationId,
            "$.payload.operationId",
            256,
          ),
        },
      };
    case "drain":
      return {
        ...base,
        kind,
        payload: {
          deadlineAt: nonNegativeSafeInteger(
            payload.deadlineAt,
            "$.payload.deadlineAt",
          ),
        },
      };
  }
}

export function parseBrowserGatewayOwnerCommand(
  value: unknown,
): BrowserGatewayOwnerCommand {
  assertSerializedLimit(
    value,
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandBytes,
    "$",
    "owner command",
  );
  const object = strictRecord(value, "$", [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "operationId",
    "emittedAt",
    "deadlineAt",
    "deadlineClass",
    "idempotency",
    "command",
  ]);
  const command = parseCommandBody(object.command, "$.command");
  const idempotency = enumValue(
    object.idempotency,
    "$.idempotency",
    new Set(BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES),
  ) as BrowserGatewayCommandIdempotency;
  if (idempotency !== BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[command.kind]) {
    fail("invalid_value", "$.idempotency", `does not match ${command.kind}`);
  }
  const emittedAt = nonNegativeSafeInteger(object.emittedAt, "$.emittedAt");
  const deadlineAt = nonNegativeSafeInteger(object.deadlineAt, "$.deadlineAt");
  const deadlineClass = enumValue(
    object.deadlineClass,
    "$.deadlineClass",
    new Set(BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES),
  ) as BrowserGatewayCommandDeadlineClass;
  const maximumDuration =
    BROWSER_GATEWAY_COMMAND_DEADLINE_MS_BY_CLASS[deadlineClass];
  const duration = deadlineAt - emittedAt;
  if (duration <= 0 || duration > maximumDuration) {
    fail(
      "invalid_value",
      "$.deadlineAt",
      "command deadline is outside the supported range",
    );
  }
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      "$.protocolVersion",
    ),
    ...parseIdentity(object, "$"),
    operationId: nonEmptyString(object.operationId, "$.operationId", 256),
    emittedAt,
    deadlineAt,
    deadlineClass,
    idempotency,
    command,
  };
}

export function parseBrowserGatewayOwnerCommandAck(
  value: unknown,
): BrowserGatewayOwnerCommandAck {
  assertControlEnvelopeLimit(value, "owner command acknowledgement");
  const object = strictRecord(value, "$", [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "operation",
    "acknowledgedAt",
  ]);
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      "$.protocolVersion",
    ),
    ...parseIdentity(object, "$"),
    operation: parseOperation(object.operation, "$.operation"),
    acknowledgedAt: nonNegativeFiniteNumber(
      object.acknowledgedAt,
      "$.acknowledgedAt",
    ),
  };
}

export function parseBrowserGatewayOwnerRegistration(
  value: unknown,
): BrowserGatewayOwnerRegistration {
  assertControlEnvelopeLimit(value, "owner registration");
  const object = strictRecord(value, "$", [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "requestedOwnerId",
    "displayName",
    "ownerKind",
    "scope",
    "capabilities",
    "registeredAt",
  ]);
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      "$.protocolVersion",
    ),
    ...parseIdentity(object, "$"),
    requestedOwnerId: nonEmptyString(
      object.requestedOwnerId,
      "$.requestedOwnerId",
      256,
    ),
    displayName: nonEmptyString(object.displayName, "$.displayName", 500),
    ownerKind: enumValue(
      object.ownerKind,
      "$.ownerKind",
      new Set([
        "vscode",
        "browser-gateway",
        "cli",
        "desktop",
        "server",
        "test",
      ]),
    ) as BrowserGatewayOwnerRegistration["ownerKind"],
    scope: parseScope(object.scope, "$.scope"),
    capabilities: parseCapabilities(object.capabilities, "$.capabilities"),
    registeredAt: nonNegativeFiniteNumber(
      object.registeredAt,
      "$.registeredAt",
    ),
  };
}

export function parseBrowserGatewayRelayReset(
  value: unknown,
): BrowserGatewayRelayReset {
  assertControlEnvelopeLimit(value, "relay reset");
  const object = strictRecord(value, "$", [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "reason",
    "latestSequence",
    "subscriptionId",
  ]);
  const subscriptionId = optionalString(object, "subscriptionId", "$", 256);
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      "$.protocolVersion",
    ),
    ...parseIdentity(object, "$"),
    reason: enumValue(
      object.reason,
      "$.reason",
      RESET_REASONS,
    ) as BrowserGatewayRelayResetReason,
    latestSequence: nonNegativeSafeInteger(
      object.latestSequence,
      "$.latestSequence",
    ),
    ...(subscriptionId ? { subscriptionId } : {}),
  };
}

function parseCheckpoint(
  value: unknown,
  path: string,
  enforceLimit: boolean,
): BrowserGatewayOwnerCheckpoint {
  if (enforceLimit) {
    assertSerializedLimit(
      value,
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointBytes,
      path,
      "checkpoint",
    );
  }
  const object = strictRecord(value, path, [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "checkpointId",
    "checkpointSequence",
    "emittedAt",
    "foreground",
    "catalog",
    "transcript",
    "ui",
    "background",
    "fleet",
    "diffs",
    "repository",
    "theme",
    "modelCatalogRevision",
    "pluginCatalogRevision",
    "capabilities",
  ]);
  const transcript = parseTranscriptWindow(
    object.transcript,
    `${path}.transcript`,
  );
  if (
    transcript.messages.length >
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages
  ) {
    fail(
      "resource_limit",
      `${path}.transcript.messages`,
      "checkpoint message limit exceeded",
    );
  }
  if (
    transcript.messages.filter((message) => message.role === "user").length >
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointUserTurns
  ) {
    fail(
      "resource_limit",
      `${path}.transcript.messages`,
      "checkpoint user-turn limit exceeded",
    );
  }
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      `${path}.protocolVersion`,
    ),
    ...parseIdentity(object, path),
    checkpointId: nonEmptyString(
      object.checkpointId,
      `${path}.checkpointId`,
      256,
    ),
    checkpointSequence: nonNegativeSafeInteger(
      object.checkpointSequence,
      `${path}.checkpointSequence`,
    ),
    emittedAt: nonNegativeFiniteNumber(object.emittedAt, `${path}.emittedAt`),
    foreground:
      object.foreground === null
        ? null
        : parseForeground(object.foreground, `${path}.foreground`),
    catalog: parseSessionCatalog(object.catalog, `${path}.catalog`),
    transcript,
    ui: parseInteractionState(object.ui, `${path}.ui`),
    background: parseBackgroundList(object.background, `${path}.background`),
    fleet: parseBackgroundList(object.fleet, `${path}.fleet`),
    diffs: parseDiffs(object.diffs, `${path}.diffs`),
    repository:
      object.repository === null
        ? null
        : parseRepository(object.repository, `${path}.repository`),
    theme: parseTheme(object.theme, `${path}.theme`),
    modelCatalogRevision: nonEmptyString(
      object.modelCatalogRevision,
      `${path}.modelCatalogRevision`,
      256,
    ),
    ...(object.pluginCatalogRevision === undefined
      ? {}
      : {
          pluginCatalogRevision: nonEmptyString(
            object.pluginCatalogRevision,
            `${path}.pluginCatalogRevision`,
            256,
          ),
        }),
    capabilities: parseCapabilities(
      object.capabilities,
      `${path}.capabilities`,
    ),
  };
}

function parseEvent(value: unknown, path: string): BrowserGatewayOwnerEvent {
  const object = strictRecord(value, path, [
    "protocolVersion",
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "ownerSequence",
    "eventId",
    "kind",
    "emittedAt",
    "payload",
  ]);
  const kind = enumValue(
    object.kind,
    `${path}.kind`,
    EVENT_KINDS,
    "unsupported_kind",
  ) as BrowserGatewayOwnerEventKind;
  assertSerializedLimit(
    object.payload,
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerEventPayloadBytes,
    `${path}.payload`,
    "event payload",
  );
  return {
    protocolVersion: protocolVersion(
      object.protocolVersion,
      `${path}.protocolVersion`,
    ),
    ...parseIdentity(object, path),
    ownerSequence: positiveSafeInteger(
      object.ownerSequence,
      `${path}.ownerSequence`,
    ),
    eventId: nonEmptyString(object.eventId, `${path}.eventId`, 256),
    kind,
    emittedAt: nonNegativeFiniteNumber(object.emittedAt, `${path}.emittedAt`),
    payload: parseEventPayload(kind, object.payload, `${path}.payload`),
  };
}

function parseEventPayload(
  kind: BrowserGatewayOwnerEventKind,
  value: unknown,
  path: string,
): BrowserGatewayOwnerEventPayload {
  switch (kind) {
    case "foreground.control.updated": {
      const object = strictRecord(value, path, ["foreground"]);
      return {
        foreground:
          object.foreground === null
            ? null
            : parseForeground(object.foreground, `${path}.foreground`),
      };
    }
    case "session.catalog.updated": {
      const object = strictRecord(value, path, ["catalog"]);
      return {
        catalog: parseSessionCatalog(object.catalog, `${path}.catalog`),
      };
    }
    case "transcript.message.appended":
    case "transcript.message.upserted": {
      const object = strictRecord(value, path, ["message"]);
      return { message: parseMessage(object.message, `${path}.message`) };
    }
    case "transcript.block.delta": {
      const object = strictRecord(value, path, [
        "messageId",
        "blockId",
        "field",
        "delta",
        "revision",
      ]);
      return {
        messageId: nonEmptyString(object.messageId, `${path}.messageId`, 256),
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        field: enumValue(
          object.field,
          `${path}.field`,
          new Set(["text", "thinking"]),
        ) as "text" | "thinking",
        delta: boundedString(object.delta, `${path}.delta`, 256 * 1024),
        revision: positiveSafeInteger(object.revision, `${path}.revision`),
      };
    }
    case "transcript.history.prepended":
      return parseTranscriptWindow(value, path);
    case "interaction.updated": {
      const object = strictRecord(value, path, ["interaction"]);
      return {
        interaction:
          object.interaction === null
            ? null
            : parseInteraction(object.interaction, `${path}.interaction`),
      };
    }
    case "queue.updated": {
      const object = strictRecord(value, path, ["queue"]);
      return { queue: parseQueue(object.queue, `${path}.queue`) };
    }
    case "todo.updated": {
      const object = strictRecord(value, path, ["todos"]);
      return { todos: parseTodos(object.todos, `${path}.todos`) };
    }
    case "background.updated":
    case "fleet.updated": {
      const object = strictRecord(value, path, ["sessions"]);
      return {
        sessions: parseBackgroundList(object.sessions, `${path}.sessions`),
      };
    }
    case "diff.preview.updated": {
      const object = strictRecord(value, path, ["diffs"]);
      return { diffs: parseDiffs(object.diffs, `${path}.diffs`) };
    }
    case "repository.updated": {
      const object = strictRecord(value, path, ["repository"]);
      return {
        repository:
          object.repository === null
            ? null
            : parseRepository(object.repository, `${path}.repository`),
      };
    }
    case "theme.updated": {
      const object = strictRecord(value, path, ["theme"]);
      return { theme: parseTheme(object.theme, `${path}.theme`) };
    }
    case "model_catalog.revision.updated":
    case "plugin_catalog.revision.updated": {
      const object = strictRecord(value, path, ["revision"]);
      return {
        revision: nonEmptyString(object.revision, `${path}.revision`, 256),
      };
    }
    case "owner.capabilities.updated": {
      const object = strictRecord(value, path, ["capabilities"]);
      return {
        capabilities: parseCapabilities(
          object.capabilities,
          `${path}.capabilities`,
        ),
      };
    }
    case "operation.updated": {
      const object = strictRecord(value, path, ["operation"]);
      return {
        operation: parseOperation(object.operation, `${path}.operation`),
      };
    }
  }
}

function parseIdentity(
  object: Record<string, unknown>,
  path: string,
): BrowserGatewayDataPlaneIdentity {
  return {
    helperGenerationId: nonEmptyString(
      object.helperGenerationId,
      `${path}.helperGenerationId`,
      256,
    ),
    ownerId: nonEmptyString(object.ownerId, `${path}.ownerId`, 256),
    ownerGenerationId: nonEmptyString(
      object.ownerGenerationId,
      `${path}.ownerGenerationId`,
      256,
    ),
  };
}

function parseDetailHandle(
  value: unknown,
  path: string,
): BrowserGatewayDetailHandle {
  const object = strictRecord(value, path, [
    "helperGenerationId",
    "ownerId",
    "ownerGenerationId",
    "handleId",
    "kind",
    "byteLength",
    "expiresAt",
    "mediaType",
  ]);
  const mediaType = optionalString(object, "mediaType", path, 256);
  const kind = enumValue(
    object.kind,
    `${path}.kind`,
    new Set(BROWSER_GATEWAY_DETAIL_HANDLE_KINDS),
  ) as BrowserGatewayDetailHandle["kind"];
  const byteLength = positiveSafeInteger(
    object.byteLength,
    `${path}.byteLength`,
  );
  if (byteLength > browserGatewayDetailResponseByteLimit(kind)) {
    fail(
      "resource_limit",
      `${path}.byteLength`,
      "detail response limit exceeded",
    );
  }
  return {
    ...parseIdentity(object, path),
    handleId: nonEmptyString(object.handleId, `${path}.handleId`, 256),
    kind,
    byteLength,
    expiresAt: nonNegativeFiniteNumber(object.expiresAt, `${path}.expiresAt`),
    ...(mediaType ? { mediaType } : {}),
  };
}

function parseForeground(
  value: unknown,
  path: string,
): BrowserGatewayForegroundControlState {
  const object = strictRecord(value, path, [
    "sessionId",
    "title",
    "originalPrompt",
    "mode",
    "model",
    "status",
    "interactiveExecutionPhase",
    "streaming",
    "interrupted",
    "estimatedTokens",
    "maximumTokens",
    "statusOverride",
    "thinkingEnabled",
    "reasoningEffort",
    "lastInputTokens",
    "lastOutputTokens",
    "lastCacheReadTokens",
    "contextBudget",
    "contextHealth",
    "condenseThreshold",
    "agentWriteApproval",
    "commandApprovalPolicy",
    "approvalPolicy",
    "approvalReviewer",
    "executionPreset",
    "configuredCommandApprovalPolicy",
    "restoringSession",
    "revertRecoveryNotice",
  ]);
  const estimatedTokens = optionalNonNegativeInteger(
    object,
    "estimatedTokens",
    path,
  );
  const maximumTokens = optionalNonNegativeInteger(
    object,
    "maximumTokens",
    path,
  );
  const lastInputTokens = optionalNonNegativeInteger(
    object,
    "lastInputTokens",
    path,
  );
  const lastOutputTokens = optionalNonNegativeInteger(
    object,
    "lastOutputTokens",
    path,
  );
  const lastCacheReadTokens = optionalNonNegativeInteger(
    object,
    "lastCacheReadTokens",
    path,
  );
  const statusOverride = parseOptionalNullableString(
    object,
    "statusOverride",
    path,
    4_000,
  );
  const contextBudget = optionalObject(
    object,
    "contextBudget",
    path,
    parseContextBudget,
  );
  const contextHealth = parseOptionalNullableObject(
    object,
    "contextHealth",
    path,
    parseContextHealth,
  );
  const revertRecoveryNotice = parseOptionalNullableObject(
    object,
    "revertRecoveryNotice",
    path,
    parseRevertRecoveryNotice,
  );
  return {
    sessionId: nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
    title: boundedString(object.title, `${path}.title`, 1_000),
    ...(object.originalPrompt !== undefined
      ? {
          originalPrompt: boundedString(
            object.originalPrompt,
            `${path}.originalPrompt`,
            16_000,
          ),
        }
      : {}),
    mode: nonEmptyString(object.mode, `${path}.mode`, 128),
    model: nonEmptyString(object.model, `${path}.model`, 256),
    status: nonEmptyString(object.status, `${path}.status`, 128),
    ...(object.interactiveExecutionPhase !== undefined
      ? {
          interactiveExecutionPhase: enumValue(
            object.interactiveExecutionPhase,
            `${path}.interactiveExecutionPhase`,
            new Set([
              "queued_for_workspace_write",
              "queued_for_provider",
              "running",
              "awaiting_input",
              "stopping",
            ]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["interactiveExecutionPhase"]
          >,
        }
      : {}),
    streaming: booleanValue(object.streaming, `${path}.streaming`),
    ...(object.interrupted !== undefined
      ? {
          interrupted: booleanValue(object.interrupted, `${path}.interrupted`),
        }
      : {}),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(maximumTokens !== undefined ? { maximumTokens } : {}),
    ...(statusOverride.present ? { statusOverride: statusOverride.value } : {}),
    ...(object.thinkingEnabled !== undefined
      ? {
          thinkingEnabled: booleanValue(
            object.thinkingEnabled,
            `${path}.thinkingEnabled`,
          ),
        }
      : {}),
    ...(object.reasoningEffort !== undefined
      ? {
          reasoningEffort: enumValue(
            object.reasoningEffort,
            `${path}.reasoningEffort`,
            new Set(CORE_REASONING_EFFORTS),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["reasoningEffort"]
          >,
        }
      : {}),
    ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    ...(lastOutputTokens !== undefined ? { lastOutputTokens } : {}),
    ...(lastCacheReadTokens !== undefined ? { lastCacheReadTokens } : {}),
    ...(contextBudget ? { contextBudget } : {}),
    ...(contextHealth.present ? { contextHealth: contextHealth.value } : {}),
    ...(object.condenseThreshold !== undefined
      ? {
          condenseThreshold: unitIntervalNumber(
            object.condenseThreshold,
            `${path}.condenseThreshold`,
          ),
        }
      : {}),
    ...(object.agentWriteApproval !== undefined
      ? {
          agentWriteApproval: enumValue(
            object.agentWriteApproval,
            `${path}.agentWriteApproval`,
            new Set(["prompt", "session", "project", "global"]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["agentWriteApproval"]
          >,
        }
      : {}),
    ...(object.commandApprovalPolicy !== undefined
      ? {
          commandApprovalPolicy: enumValue(
            object.commandApprovalPolicy,
            `${path}.commandApprovalPolicy`,
            new Set(["manual", "safe", "approve-for-me", "sensitive"]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["commandApprovalPolicy"]
          >,
        }
      : {}),
    ...(object.approvalPolicy !== undefined
      ? {
          approvalPolicy: enumValue(
            object.approvalPolicy,
            `${path}.approvalPolicy`,
            new Set(["on-request"]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["approvalPolicy"]
          >,
        }
      : {}),
    ...(object.approvalReviewer !== undefined
      ? {
          approvalReviewer: enumValue(
            object.approvalReviewer,
            `${path}.approvalReviewer`,
            new Set(["user", "auto-review"]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["approvalReviewer"]
          >,
        }
      : {}),
    ...(object.executionPreset !== undefined
      ? {
          executionPreset: enumValue(
            object.executionPreset,
            `${path}.executionPreset`,
            new Set(["native-manual", "workspace-write"]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["executionPreset"]
          >,
        }
      : {}),
    ...(object.configuredCommandApprovalPolicy !== undefined
      ? {
          configuredCommandApprovalPolicy: enumValue(
            object.configuredCommandApprovalPolicy,
            `${path}.configuredCommandApprovalPolicy`,
            new Set(["manual", "safe", "sensitive"]),
          ) as NonNullable<
            BrowserGatewayForegroundControlState["configuredCommandApprovalPolicy"]
          >,
        }
      : {}),
    ...(object.restoringSession !== undefined
      ? {
          restoringSession: booleanValue(
            object.restoringSession,
            `${path}.restoringSession`,
          ),
        }
      : {}),
    ...(revertRecoveryNotice.present
      ? { revertRecoveryNotice: revertRecoveryNotice.value }
      : {}),
  };
}

function parseContextBudget(
  value: unknown,
  path: string,
): BrowserGatewayContextBudget {
  const object = strictRecord(value, path, [
    "contextWindow",
    "maxInputTokens",
    "usedInputTokens",
    "outputReservation",
    "safetyBufferTokens",
    "softThresholdBudget",
    "hardBudget",
  ]);
  const contextWindow = nonNegativeSafeInteger(
    object.contextWindow,
    `${path}.contextWindow`,
  );
  const maxInputTokens = nonNegativeSafeInteger(
    object.maxInputTokens,
    `${path}.maxInputTokens`,
  );
  const usedInputTokens = nonNegativeSafeInteger(
    object.usedInputTokens,
    `${path}.usedInputTokens`,
  );
  const outputReservation = nonNegativeSafeInteger(
    object.outputReservation,
    `${path}.outputReservation`,
  );
  const safetyBufferTokens = nonNegativeSafeInteger(
    object.safetyBufferTokens,
    `${path}.safetyBufferTokens`,
  );
  const softThresholdBudget = nonNegativeSafeInteger(
    object.softThresholdBudget,
    `${path}.softThresholdBudget`,
  );
  const hardBudget = nonNegativeSafeInteger(
    object.hardBudget,
    `${path}.hardBudget`,
  );

  if (maxInputTokens > contextWindow) {
    fail(
      "invalid_value",
      `${path}.maxInputTokens`,
      "max input tokens must not exceed the context window",
    );
  }
  if (outputReservation > contextWindow) {
    fail(
      "invalid_value",
      `${path}.outputReservation`,
      "output reservation must not exceed the context window",
    );
  }
  if (safetyBufferTokens > maxInputTokens) {
    fail(
      "invalid_value",
      `${path}.safetyBufferTokens`,
      "safety buffer must not exceed max input tokens",
    );
  }
  if (softThresholdBudget > maxInputTokens) {
    fail(
      "invalid_value",
      `${path}.softThresholdBudget`,
      "soft threshold budget must not exceed max input tokens",
    );
  }
  if (hardBudget > maxInputTokens) {
    fail(
      "invalid_value",
      `${path}.hardBudget`,
      "hard budget must not exceed max input tokens",
    );
  }

  return {
    contextWindow,
    maxInputTokens,
    usedInputTokens,
    outputReservation,
    safetyBufferTokens,
    softThresholdBudget,
    hardBudget,
  };
}

function parseContextHealth(
  value: unknown,
  path: string,
): ContextHealthSnapshot {
  const object = strictRecord(value, path, ["memory", "retrieval", "index"]);
  const memory = strictRecord(object.memory, `${path}.memory`, [
    "status",
    "retrieval",
    "activeRecordCount",
    "reason",
  ]);
  const retrieval = strictRecord(object.retrieval, `${path}.retrieval`, [
    "status",
    "lexical",
    "vector",
    "structural",
    "sourceCount",
    "chunkCount",
    "staleSourceCount",
    "reason",
  ]);
  const index = strictRecord(object.index, `${path}.index`, [
    "status",
    "state",
    "current",
    "total",
    "totalFilesInIndex",
    "totalChunksInIndex",
    "reason",
  ]);
  const statusValues = new Set([
    "ready",
    "working",
    "degraded",
    "unavailable",
    "disabled",
    "not_measured",
  ]);
  const optionalCount = (
    record: Record<string, unknown>,
    key: string,
    base: string,
  ) => optionalNonNegativeInteger(record, key, base);
  const optionalReason = (record: Record<string, unknown>, base: string) =>
    optionalString(record, "reason", base, 240);
  const memoryActiveRecordCount = optionalCount(
    memory,
    "activeRecordCount",
    `${path}.memory`,
  );
  const memoryReason = optionalReason(memory, `${path}.memory`);
  const retrievalSourceCount = optionalCount(
    retrieval,
    "sourceCount",
    `${path}.retrieval`,
  );
  const retrievalChunkCount = optionalCount(
    retrieval,
    "chunkCount",
    `${path}.retrieval`,
  );
  const retrievalStaleSourceCount = optionalCount(
    retrieval,
    "staleSourceCount",
    `${path}.retrieval`,
  );
  const retrievalReason = optionalReason(retrieval, `${path}.retrieval`);
  const indexCurrent = optionalCount(index, "current", `${path}.index`);
  const indexTotal = optionalCount(index, "total", `${path}.index`);
  const indexTotalFiles = optionalCount(
    index,
    "totalFilesInIndex",
    `${path}.index`,
  );
  const indexTotalChunks = optionalCount(
    index,
    "totalChunksInIndex",
    `${path}.index`,
  );
  const indexReason = optionalReason(index, `${path}.index`);
  return {
    memory: {
      status: enumValue(
        memory.status,
        `${path}.memory.status`,
        statusValues,
      ) as ContextHealthSnapshot["memory"]["status"],
      retrieval: enumValue(
        memory.retrieval,
        `${path}.memory.retrieval`,
        new Set(["lexical-only", "hybrid", "unavailable", "not_measured"]),
      ) as ContextHealthSnapshot["memory"]["retrieval"],
      ...(memoryActiveRecordCount !== undefined
        ? { activeRecordCount: memoryActiveRecordCount }
        : {}),
      ...(memoryReason ? { reason: memoryReason } : {}),
    },
    retrieval: {
      status: enumValue(
        retrieval.status,
        `${path}.retrieval.status`,
        statusValues,
      ) as ContextHealthSnapshot["retrieval"]["status"],
      lexical: enumValue(
        retrieval.lexical,
        `${path}.retrieval.lexical`,
        new Set(["ready", "unavailable", "not_measured"]),
      ) as ContextHealthSnapshot["retrieval"]["lexical"],
      vector: enumValue(
        retrieval.vector,
        `${path}.retrieval.vector`,
        new Set(["ready", "unavailable", "not_configured", "not_measured"]),
      ) as ContextHealthSnapshot["retrieval"]["vector"],
      structural: enumValue(
        retrieval.structural,
        `${path}.retrieval.structural`,
        new Set(["ready", "unavailable", "not_measured"]),
      ) as ContextHealthSnapshot["retrieval"]["structural"],
      ...(retrievalSourceCount !== undefined
        ? { sourceCount: retrievalSourceCount }
        : {}),
      ...(retrievalChunkCount !== undefined
        ? { chunkCount: retrievalChunkCount }
        : {}),
      ...(retrievalStaleSourceCount !== undefined
        ? { staleSourceCount: retrievalStaleSourceCount }
        : {}),
      ...(retrievalReason ? { reason: retrievalReason } : {}),
    },
    index: {
      status: enumValue(
        index.status,
        `${path}.index.status`,
        statusValues,
      ) as ContextHealthSnapshot["index"]["status"],
      state: enumValue(
        index.state,
        `${path}.index.state`,
        new Set([
          "idle",
          "discovering",
          "indexing",
          "error",
          "disabled",
          "not_measured",
        ]),
      ) as ContextHealthSnapshot["index"]["state"],
      ...(indexCurrent !== undefined ? { current: indexCurrent } : {}),
      ...(indexTotal !== undefined ? { total: indexTotal } : {}),
      ...(indexTotalFiles !== undefined
        ? { totalFilesInIndex: indexTotalFiles }
        : {}),
      ...(indexTotalChunks !== undefined
        ? { totalChunksInIndex: indexTotalChunks }
        : {}),
      ...(indexReason ? { reason: indexReason } : {}),
    },
  };
}

function parseRevertRecoveryNotice(
  value: unknown,
  path: string,
): BrowserGatewayRevertRecoveryNotice {
  const object = strictRecord(value, path, [
    "projectId",
    "checkpointId",
    "sessionRevision",
    "workspaceRevision",
    "startedAt",
    "title",
    "message",
  ]);
  const workspaceRevision = optionalString(
    object,
    "workspaceRevision",
    path,
    256,
  );
  return {
    projectId: nonEmptyString(object.projectId, `${path}.projectId`, 256),
    checkpointId: nonEmptyString(
      object.checkpointId,
      `${path}.checkpointId`,
      256,
    ),
    sessionRevision: nonEmptyString(
      object.sessionRevision,
      `${path}.sessionRevision`,
      256,
    ),
    ...(workspaceRevision ? { workspaceRevision } : {}),
    startedAt: nonNegativeFiniteNumber(object.startedAt, `${path}.startedAt`),
    title: boundedString(object.title, `${path}.title`, 1_000),
    message: boundedString(object.message, `${path}.message`, 4_000),
  };
}

function parseOptionalNullableString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  maxLength: number,
): { present: false } | { present: true; value: string | null } {
  if (!Object.hasOwn(object, key)) return { present: false };
  const value = object[key];
  return {
    present: true,
    value:
      value === null ? null : boundedString(value, `${path}.${key}`, maxLength),
  };
}

function parseOptionalNullableObject<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parse: (value: unknown, path: string) => T,
): { present: false } | { present: true; value: T | null } {
  if (!Object.hasOwn(object, key)) return { present: false };
  const value = object[key];
  return {
    present: true,
    value: value === null ? null : parse(value, `${path}.${key}`),
  };
}

function parseSessionCatalog(
  value: unknown,
  path: string,
): BrowserGatewaySessionCatalog {
  const object = strictRecord(value, path, [
    "projects",
    "sessions",
    "defaultProjectId",
    "foregroundSessionId",
    "chatWorkspace",
  ]);
  const projects = arrayValue(object.projects, `${path}.projects`).map(
    (item, index): BrowserGatewayProjectSummary => {
      const itemPath = `${path}.projects[${index}]`;
      const project = strictRecord(item, itemPath, [
        "projectId",
        "displayName",
        "availability",
      ]);
      return {
        projectId: nonEmptyString(
          project.projectId,
          `${itemPath}.projectId`,
          256,
        ),
        displayName: nonEmptyString(
          project.displayName,
          `${itemPath}.displayName`,
          1_000,
        ),
        availability: enumValue(
          project.availability,
          `${itemPath}.availability`,
          new Set(["available", "unavailable"]),
        ) as BrowserGatewayProjectSummary["availability"],
      };
    },
  );
  const sessions = arrayValue(object.sessions, `${path}.sessions`).map(
    (item, index): BrowserGatewaySessionSummary => {
      const itemPath = `${path}.sessions[${index}]`;
      const session = strictRecord(item, itemPath, [
        "sessionId",
        "projectId",
        "title",
        "mode",
        "model",
        "messageCount",
        "createdAt",
        "updatedAt",
      ]);
      return {
        sessionId: nonEmptyString(
          session.sessionId,
          `${itemPath}.sessionId`,
          256,
        ),
        projectId:
          session.projectId === null
            ? null
            : nonEmptyString(session.projectId, `${itemPath}.projectId`, 256),
        title: boundedString(session.title, `${itemPath}.title`, 1_000),
        mode: nonEmptyString(session.mode, `${itemPath}.mode`, 256),
        model: nonEmptyString(session.model, `${itemPath}.model`, 256),
        messageCount: nonNegativeSafeInteger(
          session.messageCount,
          `${itemPath}.messageCount`,
        ),
        createdAt: nonNegativeSafeInteger(
          session.createdAt,
          `${itemPath}.createdAt`,
        ),
        updatedAt: nonNegativeSafeInteger(
          session.updatedAt,
          `${itemPath}.updatedAt`,
        ),
      };
    },
  );
  return {
    projects,
    sessions,
    defaultProjectId:
      object.defaultProjectId === null
        ? null
        : nonEmptyString(
            object.defaultProjectId,
            `${path}.defaultProjectId`,
            256,
          ),
    foregroundSessionId:
      object.foregroundSessionId === null
        ? null
        : nonEmptyString(
            object.foregroundSessionId,
            `${path}.foregroundSessionId`,
            256,
          ),
    chatWorkspace:
      object.chatWorkspace === undefined || object.chatWorkspace === null
        ? null
        : parseChatWorkspace(object.chatWorkspace, `${path}.chatWorkspace`),
  };
}

function parseChatWorkspace(
  value: unknown,
  path: string,
): BrowserGatewayChatWorkspaceSummary {
  const object = strictRecord(value, path, [
    "controllerEpoch",
    "focusedTabId",
    "tabs",
  ]);
  return {
    controllerEpoch: nonEmptyString(
      object.controllerEpoch,
      `${path}.controllerEpoch`,
      256,
    ),
    focusedTabId: nonEmptyString(
      object.focusedTabId,
      `${path}.focusedTabId`,
      256,
    ),
    tabs: arrayValue(object.tabs, `${path}.tabs`).map((item, index) =>
      parseChatTabSummary(item, `${path}.tabs[${index}]`),
    ),
  };
}

function parseChatTabSummary(
  value: unknown,
  path: string,
): BrowserGatewayChatTabSummary {
  const object = strictRecord(value, path, [
    "tabId",
    "displayNumber",
    "label",
    "sessionId",
    "placement",
    "title",
    "status",
    "busy",
    "needsAttention",
    "mode",
    "model",
    "interactiveExecutionPhase",
    "estimatedTokens",
    "maximumTokens",
  ]);
  return {
    tabId: nonEmptyString(object.tabId, `${path}.tabId`, 256),
    displayNumber: positiveSafeInteger(
      object.displayNumber,
      `${path}.displayNumber`,
    ),
    label: nonEmptyString(object.label, `${path}.label`, 64),
    sessionId:
      object.sessionId === null
        ? null
        : nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
    placement: enumValue(
      object.placement,
      `${path}.placement`,
      new Set(["docked", "popped"]),
    ) as BrowserGatewayChatTabSummary["placement"],
    ...(object.title === undefined
      ? {}
      : { title: boundedString(object.title, `${path}.title`, 1_000) }),
    status: enumValue(
      object.status,
      `${path}.status`,
      new Set([
        "idle",
        "streaming",
        "queued_for_provider",
        "queued_for_workspace_write",
        "needs_input",
        "failed",
        "completed",
      ]),
    ) as BrowserGatewayChatTabStatus,
    busy: booleanValue(object.busy, `${path}.busy`),
    ...(object.needsAttention === undefined
      ? {}
      : {
          needsAttention: booleanValue(
            object.needsAttention,
            `${path}.needsAttention`,
          ),
        }),
    ...(object.mode === undefined
      ? {}
      : { mode: nonEmptyString(object.mode, `${path}.mode`, 256) }),
    ...(object.model === undefined
      ? {}
      : { model: nonEmptyString(object.model, `${path}.model`, 256) }),
    ...(object.interactiveExecutionPhase === undefined
      ? {}
      : {
          interactiveExecutionPhase: enumValue(
            object.interactiveExecutionPhase,
            `${path}.interactiveExecutionPhase`,
            new Set([
              "queued_for_provider",
              "queued_for_workspace_write",
              "running",
              "awaiting_input",
              "stopping",
            ]),
          ) as NonNullable<
            BrowserGatewayChatTabSummary["interactiveExecutionPhase"]
          >,
        }),
    ...(object.estimatedTokens === undefined
      ? {}
      : {
          estimatedTokens: nonNegativeSafeInteger(
            object.estimatedTokens,
            `${path}.estimatedTokens`,
          ),
        }),
    ...(object.maximumTokens === undefined
      ? {}
      : {
          maximumTokens: nonNegativeSafeInteger(
            object.maximumTokens,
            `${path}.maximumTokens`,
          ),
        }),
  };
}

function parseTranscriptWindow(
  value: unknown,
  path: string,
): BrowserGatewayTranscriptWindow {
  const object = strictRecord(value, path, [
    "messages",
    "earlierCursor",
    "hasEarlier",
  ]);
  const messages = arrayValue(object.messages, `${path}.messages`).map(
    (message, index) => parseMessage(message, `${path}.messages[${index}]`),
  );
  return {
    messages,
    earlierCursor:
      object.earlierCursor === null
        ? null
        : nonEmptyString(object.earlierCursor, `${path}.earlierCursor`, 1_000),
    hasEarlier: booleanValue(object.hasEarlier, `${path}.hasEarlier`),
  };
}

function parseMessage(
  value: unknown,
  path: string,
): BrowserGatewayTranscriptMessage {
  const object = strictRecord(value, path, [
    "messageId",
    "role",
    "revision",
    "createdAt",
    "content",
    "blocks",
    "badge",
    "isSlashCommand",
    "slashCommandLabel",
    "origin",
    "checkpointId",
    "finalMarker",
    "surfaceChange",
    "error",
    "apiRequest",
    "condenseInfo",
    "warningMessage",
    "warningRetry",
  ]);
  const badge = optionalEnum(
    object,
    "badge",
    path,
    new Set(["follow-up", "rejection"]),
  ) as BrowserGatewayTranscriptMessage["badge"];
  const isSlashCommand = optionalBoolean(object, "isSlashCommand", path);
  const slashCommandLabel = optionalString(
    object,
    "slashCommandLabel",
    path,
    1_000,
  );
  const origin = optionalEnum(
    object,
    "origin",
    path,
    new Set(["vscode", "browser"]),
  ) as BrowserGatewayTranscriptMessage["origin"];
  const checkpointId = optionalString(object, "checkpointId", path, 256);
  const finalMarker = optionalObject(
    object,
    "finalMarker",
    path,
    parseFinalMarker,
  );
  const surfaceChange = optionalObject(
    object,
    "surfaceChange",
    path,
    parseSurfaceChange,
  );
  const error = optionalObject(object, "error", path, parseMessageError);
  const apiRequest = optionalObject(
    object,
    "apiRequest",
    path,
    parseApiRequest,
  );
  const condenseInfo = optionalObject(
    object,
    "condenseInfo",
    path,
    parseCondenseInfo,
  );
  const warningMessage = optionalString(object, "warningMessage", path, 8_000);
  const warningRetry = optionalObject(
    object,
    "warningRetry",
    path,
    parseWarningRetry,
  );
  return {
    messageId: nonEmptyString(object.messageId, `${path}.messageId`, 256),
    role: enumValue(
      object.role,
      `${path}.role`,
      new Set(["user", "assistant", "condense", "warning"]),
    ) as BrowserGatewayTranscriptMessage["role"],
    revision: positiveSafeInteger(object.revision, `${path}.revision`),
    createdAt: nonNegativeFiniteNumber(object.createdAt, `${path}.createdAt`),
    content: parseTranscriptText(object.content, `${path}.content`),
    blocks: arrayValue(object.blocks, `${path}.blocks`).map((block, index) =>
      parseTranscriptBlock(block, `${path}.blocks[${index}]`),
    ),
    ...(badge ? { badge } : {}),
    ...(isSlashCommand !== undefined ? { isSlashCommand } : {}),
    ...(slashCommandLabel ? { slashCommandLabel } : {}),
    ...(origin ? { origin } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(finalMarker ? { finalMarker } : {}),
    ...(surfaceChange ? { surfaceChange } : {}),
    ...(error ? { error } : {}),
    ...(apiRequest ? { apiRequest } : {}),
    ...(condenseInfo ? { condenseInfo } : {}),
    ...(warningMessage ? { warningMessage } : {}),
    ...(warningRetry ? { warningRetry } : {}),
  };
}

function parseTranscriptText(
  value: unknown,
  path: string,
): BrowserGatewayTranscriptText {
  const discriminator = recordValue(value, path).kind;
  if (discriminator === "inline") {
    const object = strictRecord(value, path, ["kind", "text"]);
    return {
      kind: "inline",
      text: boundedUtf8String(
        object.text,
        `${path}.text`,
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerInlineTranscriptTextBytes,
      ),
    };
  }
  if (discriminator === "detail") {
    const object = strictRecord(value, path, [
      "kind",
      "preview",
      "detailHandle",
    ]);
    const detailHandle = parseDetailHandle(
      object.detailHandle,
      `${path}.detailHandle`,
    );
    if (detailHandle.kind !== "message") {
      fail(
        "invalid_value",
        `${path}.detailHandle.kind`,
        "transcript text requires a message detail handle",
      );
    }
    return {
      kind: "detail",
      preview: boundedString(object.preview, `${path}.preview`, 8_000),
      detailHandle,
    };
  }
  fail("unsupported_kind", `${path}.kind`, "unsupported transcript text kind");
}

function parseTranscriptBlock(
  value: unknown,
  path: string,
): BrowserGatewayTranscriptBlock {
  const discriminator = recordValue(value, path).type;
  switch (discriminator) {
    case "thinking": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "text",
        "complete",
      ]);
      return {
        type: "thinking",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        text: parseTranscriptText(object.text, `${path}.text`),
        complete: booleanValue(object.complete, `${path}.complete`),
      };
    }
    case "text": {
      const object = strictRecord(value, path, ["type", "blockId", "text"]);
      return {
        type: "text",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        text: parseTranscriptText(object.text, `${path}.text`),
      };
    }
    case "tool_call": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "toolCallId",
        "name",
        "complete",
        "durationMs",
        "startedAt",
      ]);
      const durationMs = optionalNonNegativeInteger(object, "durationMs", path);
      const startedAt = optionalNonNegativeInteger(object, "startedAt", path);
      return {
        type: "tool_call",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        toolCallId: nonEmptyString(
          object.toolCallId,
          `${path}.toolCallId`,
          256,
        ),
        name: nonEmptyString(object.name, `${path}.name`, 1_000),
        complete: booleanValue(object.complete, `${path}.complete`),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
    case "skill_load": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "skillName",
        "complete",
        "durationMs",
      ]);
      const skillName = optionalString(object, "skillName", path, 1_000);
      const durationMs = optionalNonNegativeInteger(object, "durationMs", path);
      return {
        type: "skill_load",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        ...(skillName ? { skillName } : {}),
        complete: booleanValue(object.complete, `${path}.complete`),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    }
    case "bg_agent": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "sessionId",
        "task",
        "resolvedModel",
        "resolvedProvider",
        "reasoningEffort",
        "resolvedMode",
        "taskClass",
      ]);
      const resolvedModel = optionalString(object, "resolvedModel", path, 256);
      const resolvedProvider = optionalString(
        object,
        "resolvedProvider",
        path,
        256,
      );
      const reasoningEffort = optionalEnum(
        object,
        "reasoningEffort",
        path,
        new Set(CORE_REASONING_EFFORTS),
      ) as CoreReasoningEffort | undefined;
      const resolvedMode = optionalString(object, "resolvedMode", path, 128);
      const taskClass = optionalString(object, "taskClass", path, 256);
      return {
        type: "bg_agent",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        sessionId: nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
        task: boundedString(object.task, `${path}.task`, 4_000),
        ...(resolvedModel ? { resolvedModel } : {}),
        ...(resolvedProvider ? { resolvedProvider } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(resolvedMode ? { resolvedMode } : {}),
        ...(taskClass ? { taskClass } : {}),
      };
    }
    case "bg_agent_result": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "sessionId",
        "task",
        "status",
        "resultState",
        "terminalReason",
        "result",
        "partialOutput",
        "summary",
        "retrySafe",
        "agentRetryable",
      ]);
      const result = optionalObject(
        object,
        "result",
        path,
        parseTranscriptText,
      );
      const partialOutput = optionalObject(
        object,
        "partialOutput",
        path,
        parseTranscriptText,
      );
      const resultState = optionalEnum(
        object,
        "resultState",
        path,
        new Set([
          "running",
          "completed",
          "incomplete_expected_result",
          "failed",
          "cancelled",
          "budget_exhausted",
          "interrupted",
          "authorization_lost",
        ]),
      ) as BackgroundResultState | undefined;
      const terminalReason = optionalString(
        object,
        "terminalReason",
        path,
        4_000,
      );
      const retrySafe = optionalBoolean(object, "retrySafe", path);
      const agentRetryable = optionalBoolean(object, "agentRetryable", path);
      const summary = optionalString(object, "summary", path, 4_000);
      return {
        type: "bg_agent_result",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        sessionId: nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
        task: boundedString(object.task, `${path}.task`, 4_000),
        status: enumValue(
          object.status,
          `${path}.status`,
          new Set(["completed", "error", "cancelled"]),
        ) as Extract<
          BrowserGatewayTranscriptBlock,
          { type: "bg_agent_result" }
        >["status"],
        ...(resultState ? { resultState } : {}),
        ...(terminalReason ? { terminalReason } : {}),
        ...(result ? { result } : {}),
        ...(partialOutput ? { partialOutput } : {}),
        ...(summary ? { summary } : {}),
        ...(retrySafe !== undefined ? { retrySafe } : {}),
        ...(agentRetryable !== undefined ? { agentRetryable } : {}),
      };
    }
    case "question_answer": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "toolCallId",
        "items",
      ]);
      const toolCallId = optionalString(object, "toolCallId", path, 256);
      return {
        type: "question_answer",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        ...(toolCallId ? { toolCallId } : {}),
        items: arrayValue(object.items, `${path}.items`).map((item, index) =>
          parseQuestionAnswerItem(item, `${path}.items[${index}]`),
        ),
      };
    }
    case "pairing_status": {
      const object = strictRecord(value, path, [
        "type",
        "blockId",
        "status",
        "expiresAt",
        "deviceLabel",
      ]);
      const deviceLabel = optionalString(object, "deviceLabel", path, 1_000);
      return {
        type: "pairing_status",
        blockId: nonEmptyString(object.blockId, `${path}.blockId`, 256),
        status: enumValue(
          object.status,
          `${path}.status`,
          new Set(["pending", "consumed", "expired", "cancelled"]),
        ) as Extract<
          BrowserGatewayTranscriptBlock,
          { type: "pairing_status" }
        >["status"],
        expiresAt: nonNegativeFiniteNumber(
          object.expiresAt,
          `${path}.expiresAt`,
        ),
        ...(deviceLabel ? { deviceLabel } : {}),
      };
    }
    default:
      fail(
        "unsupported_kind",
        `${path}.type`,
        "unsupported transcript block type",
      );
  }
}

function parseQuestionAnswerItem(
  value: unknown,
  path: string,
): Extract<
  BrowserGatewayTranscriptBlock,
  { type: "question_answer" }
>["items"][number] {
  const object = strictRecord(value, path, ["question", "answer", "note"]);
  const note = optionalString(object, "note", path, 4_000);
  let answer: string | string[] | number | boolean | null;
  if (object.answer === null) answer = null;
  else if (typeof object.answer === "string")
    answer = boundedString(object.answer, `${path}.answer`, 8_000);
  else if (Array.isArray(object.answer))
    answer = object.answer.map((item, index) =>
      boundedString(item, `${path}.answer[${index}]`, 8_000),
    );
  else if (typeof object.answer === "number")
    answer = finiteNumber(object.answer, `${path}.answer`);
  else if (typeof object.answer === "boolean") answer = object.answer;
  else fail("invalid_type", `${path}.answer`, "unsupported answer type");
  return {
    question: boundedString(object.question, `${path}.question`, 8_000),
    answer,
    ...(note ? { note } : {}),
  };
}

function parseFinalMarker(
  value: unknown,
  path: string,
): NonNullable<BrowserGatewayTranscriptMessage["finalMarker"]> {
  const object = strictRecord(value, path, [
    "status",
    "summary",
    "source",
    "continueAction",
    "continueActionConsumed",
    "autoContinueStopReason",
  ]);
  const summary = optionalString(object, "summary", path, 8_000);
  const continueAction = optionalObject(
    object,
    "continueAction",
    path,
    (candidate, candidatePath) => {
      const action = strictRecord(candidate, candidatePath, [
        "label",
        "prompt",
      ]);
      return {
        label: nonEmptyString(action.label, `${candidatePath}.label`, 1_000),
        prompt: nonEmptyString(action.prompt, `${candidatePath}.prompt`, 8_000),
      };
    },
  );
  const continueActionConsumed = optionalBoolean(
    object,
    "continueActionConsumed",
    path,
  );
  const autoContinueStopReason = optionalString(
    object,
    "autoContinueStopReason",
    path,
    4_000,
  );
  return {
    status: enumValue(
      object.status,
      `${path}.status`,
      new Set(["completed", "waiting_for_user", "blocked", "cancelled"]),
    ) as NonNullable<BrowserGatewayTranscriptMessage["finalMarker"]>["status"],
    ...(summary ? { summary } : {}),
    source: enumValue(
      object.source,
      `${path}.source`,
      new Set(["tool", "engine"]),
    ) as "tool" | "engine",
    ...(continueAction ? { continueAction } : {}),
    ...(continueActionConsumed !== undefined ? { continueActionConsumed } : {}),
    ...(autoContinueStopReason ? { autoContinueStopReason } : {}),
  };
}

function parseSurfaceChange(
  value: unknown,
  path: string,
): NonNullable<BrowserGatewayTranscriptMessage["surfaceChange"]> {
  const object = strictRecord(value, path, ["model", "reasoning", "mode"]);
  const model = optionalObject(
    object,
    "model",
    path,
    (candidate, candidatePath) => {
      const change = strictRecord(candidate, candidatePath, [
        "previousModel",
        "model",
      ]);
      return {
        previousModel: nonEmptyString(
          change.previousModel,
          `${candidatePath}.previousModel`,
          256,
        ),
        model: nonEmptyString(change.model, `${candidatePath}.model`, 256),
      };
    },
  );
  const reasoning = optionalObject(
    object,
    "reasoning",
    path,
    (candidate, candidatePath) => {
      const change = strictRecord(candidate, candidatePath, [
        "previousReasoningEffort",
        "reasoningEffort",
      ]);
      const efforts = new Set(CORE_REASONING_EFFORTS);
      return {
        previousReasoningEffort: enumValue(
          change.previousReasoningEffort,
          `${candidatePath}.previousReasoningEffort`,
          efforts,
        ) as NonNullable<
          NonNullable<
            BrowserGatewayTranscriptMessage["surfaceChange"]
          >["reasoning"]
        >["previousReasoningEffort"],
        reasoningEffort: enumValue(
          change.reasoningEffort,
          `${candidatePath}.reasoningEffort`,
          efforts,
        ) as NonNullable<
          NonNullable<
            BrowserGatewayTranscriptMessage["surfaceChange"]
          >["reasoning"]
        >["reasoningEffort"],
      };
    },
  );
  const mode = optionalObject(
    object,
    "mode",
    path,
    (candidate, candidatePath) => {
      const change = strictRecord(candidate, candidatePath, [
        "previousMode",
        "mode",
      ]);
      return {
        previousMode: nonEmptyString(
          change.previousMode,
          `${candidatePath}.previousMode`,
          128,
        ),
        mode: nonEmptyString(change.mode, `${candidatePath}.mode`, 128),
      };
    },
  );
  return {
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(mode ? { mode } : {}),
  };
}

function parseMessageError(
  value: unknown,
  path: string,
): NonNullable<BrowserGatewayTranscriptMessage["error"]> {
  const object = strictRecord(value, path, [
    "message",
    "retryable",
    "code",
    "actions",
  ]);
  const code = optionalString(object, "code", path, 256);
  const actions = optionalObject(
    object,
    "actions",
    path,
    (candidate, candidatePath) => {
      const action = strictRecord(candidate, candidatePath, [
        "signIn",
        "signInAnotherAccount",
        "condense",
      ]);
      const signIn = optionalBoolean(action, "signIn", candidatePath);
      const signInAnotherAccount = optionalBoolean(
        action,
        "signInAnotherAccount",
        candidatePath,
      );
      const condense = optionalBoolean(action, "condense", candidatePath);
      return {
        ...(signIn !== undefined ? { signIn } : {}),
        ...(signInAnotherAccount !== undefined ? { signInAnotherAccount } : {}),
        ...(condense !== undefined ? { condense } : {}),
      };
    },
  );
  return {
    message: boundedString(object.message, `${path}.message`, 8_000),
    retryable: booleanValue(object.retryable, `${path}.retryable`),
    ...(code ? { code } : {}),
    ...(actions ? { actions } : {}),
  };
}

function parseApiRequest(
  value: unknown,
  path: string,
): NonNullable<BrowserGatewayTranscriptMessage["apiRequest"]> {
  const object = strictRecord(value, path, [
    "requestId",
    "model",
    "reasoningEffort",
    "mode",
    "commandApprovalPolicy",
    "inputTokens",
    "uncachedInputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "outputTokens",
    "durationMs",
    "timeToFirstToken",
  ]);
  const reasoningEffort = optionalEnum(
    object,
    "reasoningEffort",
    path,
    new Set(CORE_REASONING_EFFORTS),
  ) as NonNullable<
    BrowserGatewayTranscriptMessage["apiRequest"]
  >["reasoningEffort"];
  const mode = optionalString(object, "mode", path, 256);
  const commandApprovalPolicy = optionalEnum(
    object,
    "commandApprovalPolicy",
    path,
    new Set(["manual", "safe", "approve-for-me", "sensitive"]),
  ) as NonNullable<
    BrowserGatewayTranscriptMessage["apiRequest"]
  >["commandApprovalPolicy"];
  const uncachedInputTokens = optionalNonNegativeInteger(
    object,
    "uncachedInputTokens",
    path,
  );
  const cacheReadTokens = optionalNonNegativeInteger(
    object,
    "cacheReadTokens",
    path,
  );
  const cacheCreationTokens = optionalNonNegativeInteger(
    object,
    "cacheCreationTokens",
    path,
  );
  return {
    requestId: nonEmptyString(object.requestId, `${path}.requestId`, 256),
    model: nonEmptyString(object.model, `${path}.model`, 256),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(mode ? { mode } : {}),
    ...(commandApprovalPolicy ? { commandApprovalPolicy } : {}),
    inputTokens: nonNegativeSafeInteger(
      object.inputTokens,
      `${path}.inputTokens`,
    ),
    ...(uncachedInputTokens !== undefined ? { uncachedInputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    outputTokens: nonNegativeSafeInteger(
      object.outputTokens,
      `${path}.outputTokens`,
    ),
    durationMs: nonNegativeFiniteNumber(
      object.durationMs,
      `${path}.durationMs`,
    ),
    timeToFirstToken: nonNegativeFiniteNumber(
      object.timeToFirstToken,
      `${path}.timeToFirstToken`,
    ),
  };
}

function parseCondenseInfo(
  value: unknown,
  path: string,
): NonNullable<BrowserGatewayTranscriptMessage["condenseInfo"]> {
  const object = strictRecord(value, path, [
    "prevInputTokens",
    "newInputTokens",
    "durationMs",
    "errorMessage",
    "condensing",
    "validationWarnings",
  ]);
  const durationMs = optionalNonNegativeInteger(object, "durationMs", path);
  const errorMessage = optionalString(object, "errorMessage", path, 8_000);
  const condensing = optionalBoolean(object, "condensing", path);
  const validationWarnings =
    object.validationWarnings === undefined
      ? undefined
      : arrayValue(object.validationWarnings, `${path}.validationWarnings`).map(
          (warning, index) =>
            boundedString(
              warning,
              `${path}.validationWarnings[${index}]`,
              4_000,
            ),
        );
  return {
    prevInputTokens: nonNegativeSafeInteger(
      object.prevInputTokens,
      `${path}.prevInputTokens`,
    ),
    newInputTokens: nonNegativeSafeInteger(
      object.newInputTokens,
      `${path}.newInputTokens`,
    ),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(condensing !== undefined ? { condensing } : {}),
    ...(validationWarnings ? { validationWarnings } : {}),
  };
}

function parseWarningRetry(
  value: unknown,
  path: string,
): NonNullable<BrowserGatewayTranscriptMessage["warningRetry"]> {
  const object = strictRecord(value, path, [
    "retryDelayMs",
    "retryAt",
    "retryAttempt",
    "retryMaxAttempts",
  ]);
  const retryDelayMs = optionalNonNegativeInteger(object, "retryDelayMs", path);
  const retryAt = optionalNonNegativeInteger(object, "retryAt", path);
  const retryAttempt = optionalNonNegativeInteger(object, "retryAttempt", path);
  const retryMaxAttempts = optionalNonNegativeInteger(
    object,
    "retryMaxAttempts",
    path,
  );
  return {
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(retryAttempt !== undefined ? { retryAttempt } : {}),
    ...(retryMaxAttempts !== undefined ? { retryMaxAttempts } : {}),
  };
}

function parseInteractionState(
  value: unknown,
  path: string,
): BrowserGatewayInteractionState {
  const object = strictRecord(value, path, [
    "interaction",
    "queue",
    "todos",
    "operations",
  ]);
  return {
    interaction:
      object.interaction === null
        ? null
        : parseInteraction(object.interaction, `${path}.interaction`),
    queue: parseQueue(object.queue, `${path}.queue`),
    todos: parseTodos(object.todos, `${path}.todos`),
    operations: arrayValue(object.operations, `${path}.operations`).map(
      (operation, index) =>
        parseOperation(operation, `${path}.operations[${index}]`),
    ),
  };
}

function parseInteraction(
  value: unknown,
  path: string,
): BrowserGatewayInteractionSummary {
  const object = strictRecord(value, path, [
    "requestId",
    "kind",
    "state",
    "summary",
    "step",
    "totalSteps",
    "detailHandle",
  ]);
  const step = optionalNonNegativeInteger(object, "step", path);
  const totalSteps = optionalNonNegativeInteger(object, "totalSteps", path);
  const detailHandle = optionalObject(
    object,
    "detailHandle",
    path,
    parseDetailHandle,
  );
  return {
    requestId: nonEmptyString(object.requestId, `${path}.requestId`, 256),
    kind: enumValue(
      object.kind,
      `${path}.kind`,
      new Set(BROWSER_GATEWAY_INTERACTION_KINDS),
    ) as BrowserGatewayInteractionSummary["kind"],
    state: enumValue(
      object.state,
      `${path}.state`,
      new Set(BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES),
    ) as BrowserGatewayInteractionSummary["state"],
    summary: boundedString(object.summary, `${path}.summary`, 4_000),
    ...(step !== undefined ? { step } : {}),
    ...(totalSteps !== undefined ? { totalSteps } : {}),
    ...(detailHandle ? { detailHandle } : {}),
  };
}

function parseQueue(value: unknown, path: string): BrowserGatewayQueueItem[] {
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = strictRecord(item, itemPath, ["itemId", "summary", "state"]);
    return {
      itemId: nonEmptyString(object.itemId, `${itemPath}.itemId`, 256),
      summary: boundedString(object.summary, `${itemPath}.summary`, 4_000),
      state: enumValue(
        object.state,
        `${itemPath}.state`,
        new Set(BROWSER_GATEWAY_QUEUE_ITEM_STATES),
      ) as BrowserGatewayQueueItem["state"],
    };
  });
}

function parseTodos(value: unknown, path: string): BrowserGatewayTodoItem[] {
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = strictRecord(item, itemPath, ["itemId", "text", "state"]);
    return {
      itemId: nonEmptyString(object.itemId, `${itemPath}.itemId`, 256),
      text: boundedString(object.text, `${itemPath}.text`, 4_000),
      state: enumValue(
        object.state,
        `${itemPath}.state`,
        new Set(BROWSER_GATEWAY_TODO_ITEM_STATES),
      ) as BrowserGatewayTodoItem["state"],
    };
  });
}

function parseBackgroundList(
  value: unknown,
  path: string,
): BrowserGatewayBackgroundSummary[] {
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = strictRecord(item, itemPath, [
      "sessionId",
      "title",
      "status",
      "updatedAt",
    ]);
    return {
      sessionId: nonEmptyString(object.sessionId, `${itemPath}.sessionId`, 256),
      title: boundedString(object.title, `${itemPath}.title`, 1_000),
      status: nonEmptyString(object.status, `${itemPath}.status`, 128),
      updatedAt: nonNegativeFiniteNumber(
        object.updatedAt,
        `${itemPath}.updatedAt`,
      ),
    };
  });
}

function parseDiffs(value: unknown, path: string): BrowserGatewayDiffPreview[] {
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = strictRecord(item, itemPath, [
      "requestId",
      "filePath",
      "operation",
      "outsideWorkspace",
      "createdAt",
      "detailHandle",
    ]);
    const detailHandle = optionalObject(
      object,
      "detailHandle",
      itemPath,
      parseDetailHandle,
    );
    return {
      requestId: nonEmptyString(object.requestId, `${itemPath}.requestId`, 256),
      filePath: boundedString(object.filePath, `${itemPath}.filePath`, 4_000),
      operation: nonEmptyString(object.operation, `${itemPath}.operation`, 128),
      outsideWorkspace: booleanValue(
        object.outsideWorkspace,
        `${itemPath}.outsideWorkspace`,
      ),
      createdAt: nonNegativeFiniteNumber(
        object.createdAt,
        `${itemPath}.createdAt`,
      ),
      ...(detailHandle ? { detailHandle } : {}),
    };
  });
}

function parseRepository(
  value: unknown,
  path: string,
): BrowserGatewayRepositoryState {
  const object = strictRecord(value, path, [
    "revision",
    "branch",
    "dirty",
    "rootLabel",
  ]);
  const rootLabel = optionalString(object, "rootLabel", path, 4_000);
  return {
    revision: nonEmptyString(object.revision, `${path}.revision`, 256),
    branch:
      object.branch === null
        ? null
        : boundedString(object.branch, `${path}.branch`, 1_000),
    dirty: booleanValue(object.dirty, `${path}.dirty`),
    ...(rootLabel ? { rootLabel } : {}),
  };
}

function parseTheme(value: unknown, path: string): BrowserGatewayThemeState {
  const object = strictRecord(value, path, [
    "revision",
    "colorScheme",
    "variables",
  ]);
  const variables = arrayValue(object.variables, `${path}.variables`).map(
    (item, index) => {
      const itemPath = `${path}.variables[${index}]`;
      const variable = strictRecord(item, itemPath, ["name", "value"]);
      const name = nonEmptyString(variable.name, `${itemPath}.name`, 256);
      if (!/^--vscode-[A-Za-z0-9_.-]+$/.test(name)) {
        fail(
          "invalid_value",
          `${itemPath}.name`,
          "theme variable is not allowlisted",
        );
      }
      const valuePath = `${itemPath}.value`;
      const variableValue = boundedString(variable.value, valuePath, 4_000);
      assertSafeThemeVariableValue(variableValue, valuePath);
      return { name, value: variableValue };
    },
  );
  return {
    revision: nonEmptyString(object.revision, `${path}.revision`, 256),
    colorScheme: enumValue(
      object.colorScheme,
      `${path}.colorScheme`,
      new Set(BROWSER_GATEWAY_COLOR_SCHEMES),
    ) as BrowserGatewayThemeState["colorScheme"],
    variables,
  };
}

function parseCapabilities(
  value: unknown,
  path: string,
): BrowserGatewayCapabilityStatus[] {
  return arrayValue(value, path).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = strictRecord(item, itemPath, [
      "capabilityId",
      "state",
      "reason",
    ]);
    const reason = optionalString(object, "reason", itemPath, 1_000);
    return {
      capabilityId: nonEmptyString(
        object.capabilityId,
        `${itemPath}.capabilityId`,
        256,
      ),
      state: enumValue(
        object.state,
        `${itemPath}.state`,
        new Set(BROWSER_GATEWAY_CAPABILITY_STATES),
      ) as BrowserGatewayCapabilityStatus["state"],
      ...(reason ? { reason } : {}),
    };
  });
}

function parseOperation(
  value: unknown,
  path: string,
): BrowserGatewayOperationState {
  const object = strictRecord(value, path, [
    "operationId",
    "kind",
    "state",
    "message",
    "detailHandle",
  ]);
  const kind = enumValue(
    object.kind,
    `${path}.kind`,
    COMMAND_KINDS,
    "unsupported_kind",
  ) as BrowserGatewayOwnerCommandKind;
  const message = optionalString(object, "message", path, 4_000);
  const detailHandle = optionalObject(
    object,
    "detailHandle",
    path,
    parseDetailHandle,
  );
  return {
    operationId: nonEmptyString(object.operationId, `${path}.operationId`, 256),
    kind,
    state: enumValue(
      object.state,
      `${path}.state`,
      new Set(BROWSER_GATEWAY_OPERATION_STATUSES),
    ) as BrowserGatewayOperationState["state"],
    ...(message ? { message } : {}),
    ...(detailHandle ? { detailHandle } : {}),
  };
}

function controlPayloadFields(
  kind: BrowserGatewayOwnerControlKind,
): readonly string[] {
  switch (kind) {
    case "hello":
      return ["publicationCursor", "subscriberCount"];
    case "demand.changed":
      return ["subscriberCount"];
    case "checkpoint.requested":
      return ["reason", "latestSequence"];
    case "command.cancelled":
      return ["operationId"];
    case "drain":
      return ["deadlineAt"];
  }
}

function parseCommandBody(
  value: unknown,
  path: string,
): BrowserGatewayOwnerCommandBody {
  const base = recordValue(value, path);
  const kind = enumValue(
    base.kind,
    `${path}.kind`,
    COMMAND_KINDS,
    "unsupported_kind",
  ) as BrowserGatewayOwnerCommandKind;
  switch (kind) {
    case "session.select":
    case "session.stop": {
      const object = strictRecord(value, path, ["kind", "sessionId"]);
      return {
        kind,
        sessionId: nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
      };
    }
    case "session.detail": {
      const object = strictRecord(value, path, [
        "kind",
        "instanceId",
        "controllerEpoch",
        "tabId",
        "sessionId",
      ]);
      return {
        kind,
        instanceId: nonEmptyString(
          object.instanceId,
          `${path}.instanceId`,
          256,
        ),
        controllerEpoch: nonEmptyString(
          object.controllerEpoch,
          `${path}.controllerEpoch`,
          256,
        ),
        tabId: nonEmptyString(object.tabId, `${path}.tabId`, 256),
        sessionId: nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
      };
    }
    case "session.send": {
      const object = strictRecord(value, path, [
        "kind",
        "sessionId",
        "text",
        "detailHandles",
      ]);
      return {
        kind,
        sessionId: nonEmptyString(object.sessionId, `${path}.sessionId`, 256),
        text: boundedUtf8String(
          object.text,
          `${path}.text`,
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandTextBytes,
        ),
        detailHandles: arrayValue(
          object.detailHandles,
          `${path}.detailHandles`,
        ).map((handle, index) =>
          parseDetailHandle(handle, `${path}.detailHandles[${index}]`),
        ),
      };
    }
    case "approval.respond": {
      const object = strictRecord(value, path, [
        "kind",
        "requestId",
        "decision",
      ]);
      return {
        kind,
        requestId: nonEmptyString(object.requestId, `${path}.requestId`, 256),
        decision: enumValue(
          object.decision,
          `${path}.decision`,
          new Set(["approve", "reject"]),
        ) as "approve" | "reject",
      };
    }
    case "question.respond": {
      const object = strictRecord(value, path, [
        "kind",
        "requestId",
        "responseHandle",
      ]);
      return {
        kind,
        requestId: nonEmptyString(object.requestId, `${path}.requestId`, 256),
        responseHandle: parseDetailHandle(
          object.responseHandle,
          `${path}.responseHandle`,
        ),
      };
    }
    case "history.load": {
      const object = strictRecord(value, path, ["kind", "cursor", "count"]);
      const count = positiveSafeInteger(object.count, `${path}.count`);
      if (
        count >
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages
      ) {
        fail(
          "resource_limit",
          `${path}.count`,
          "history count exceeds checkpoint message limit",
        );
      }
      return {
        kind,
        cursor: nonEmptyString(object.cursor, `${path}.cursor`, 1_000),
        count,
      };
    }
    case "diff.detail": {
      const object = strictRecord(value, path, ["kind", "requestId"]);
      return {
        kind,
        requestId: nonEmptyString(object.requestId, `${path}.requestId`, 256),
      };
    }
  }
}

function parseScope(
  value: unknown,
  path: string,
): BrowserGatewayOwnerRegistration["scope"] {
  const base = recordValue(value, path);
  if (base.kind === "workspace") {
    const object = strictRecord(value, path, [
      "kind",
      "workspaceId",
      "displayName",
    ]);
    return {
      kind: "workspace",
      workspaceId: nonEmptyString(
        object.workspaceId,
        `${path}.workspaceId`,
        256,
      ),
      displayName: nonEmptyString(
        object.displayName,
        `${path}.displayName`,
        500,
      ),
    };
  }
  if (base.kind === "projectless") {
    const object = strictRecord(value, path, [
      "kind",
      "scopeId",
      "displayName",
    ]);
    return {
      kind: "projectless",
      scopeId: nonEmptyString(object.scopeId, `${path}.scopeId`, 256),
      displayName: nonEmptyString(
        object.displayName,
        `${path}.displayName`,
        500,
      ),
    };
  }
  fail("unsupported_kind", `${path}.kind`, "unsupported owner scope kind");
}

function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const object = recordValue(value, path);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key))
      fail("unknown_field", `${path}.${key}`, "field is not allowed");
  }
  return object;
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid_type", path, "expected an array");
  return value;
}

function protocolVersion(
  value: unknown,
  path: string,
): typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION {
  if (value !== BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION) {
    fail(
      "unsupported_version",
      path,
      "unsupported data-plane protocol version",
    );
  }
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  maximumLength: number,
): string {
  if (typeof value !== "string")
    fail("invalid_type", path, "expected a string");
  if (value.length > maximumLength)
    fail("resource_limit", path, "string is too long");
  return value;
}

function boundedUtf8String(
  value: unknown,
  path: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string")
    fail("invalid_type", path, "expected a string");
  if (utf8ByteLength(value) > maximumBytes)
    fail("resource_limit", path, `string exceeds ${maximumBytes} bytes`);
  return value;
}

function nonEmptyString(
  value: unknown,
  path: string,
  maximumLength: number,
): string {
  const result = boundedString(value, path, maximumLength);
  if (!result.trim()) fail("invalid_value", path, "must not be empty");
  return result;
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  maximumLength: number,
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  return nonEmptyString(value, `${path}.${key}`, maximumLength);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    fail("invalid_type", path, "expected a boolean");
  return value;
}

function optionalBoolean(
  object: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (object[key] === undefined) return undefined;
  return booleanValue(object[key], `${path}.${key}`);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_value", path, "expected a finite number");
  }
  return value;
}

function nonNegativeFiniteNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) {
    fail("invalid_value", path, "expected a non-negative finite number");
  }
  return result;
}

function unitIntervalNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0 || result > 1) {
    fail("invalid_value", path, "expected a number between 0 and 1");
  }
  return result;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid_value", path, "expected a non-negative safe integer");
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, path: string): number {
  const result = nonNegativeSafeInteger(value, path);
  if (result === 0)
    fail("invalid_value", path, "expected a positive safe integer");
  return result;
}

function optionalNonNegativeInteger(
  object: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  if (object[key] === undefined) return undefined;
  return nonNegativeSafeInteger(object[key], `${path}.${key}`);
}

function enumValue(
  value: unknown,
  path: string,
  values: ReadonlySet<string>,
  code: BrowserGatewayProtocolErrorCode = "invalid_value",
): string {
  if (typeof value !== "string")
    fail("invalid_type", path, "expected a string");
  if (!values.has(value)) fail(code, path, "value is not allowlisted");
  return value;
}

function optionalEnum(
  object: Record<string, unknown>,
  key: string,
  path: string,
  values: ReadonlySet<string>,
): string | undefined {
  if (object[key] === undefined) return undefined;
  return enumValue(object[key], `${path}.${key}`, values);
}

function optionalObject<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: (value: unknown, path: string) => T,
): T | undefined {
  if (object[key] === undefined) return undefined;
  return parser(object[key], `${path}.${key}`);
}

function assertIdentity(
  expected: BrowserGatewayDataPlaneIdentity,
  candidate: BrowserGatewayDataPlaneIdentity | null,
  path: string,
): void {
  if (!candidate) return;
  if (
    candidate.helperGenerationId !== expected.helperGenerationId ||
    candidate.ownerId !== expected.ownerId ||
    candidate.ownerGenerationId !== expected.ownerGenerationId
  ) {
    fail(
      "identity_mismatch",
      path,
      "identity does not match publication batch",
    );
  }
}

export function isBrowserGatewaySafeThemeVariable(
  name: string,
  value: string,
): boolean {
  if (!name.startsWith("--vscode-")) return false;
  try {
    assertSafeThemeVariableValue(value, "theme.variable");
    return true;
  } catch {
    return false;
  }
}

function assertSafeThemeVariableValue(value: string, path: string): void {
  const normalized = decodeCssEscapes(value);
  if (
    normalized.includes(";") ||
    normalized.includes("{") ||
    normalized.includes("}") ||
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    fail(
      "invalid_value",
      path,
      "theme variable contains declaration-breaking characters",
    );
  }
  if (/\/\*/.test(normalized)) {
    fail("invalid_value", path, "theme variable comments are not allowed");
  }
  if (/\\/.test(normalized)) {
    fail(
      "invalid_value",
      path,
      "theme variable contains an invalid CSS escape",
    );
  }
  if (
    /(?:^|[^A-Za-z0-9_-])(?:url|(?:-webkit-)?image-set|cross-fade|element|paint)\s*\(/i.test(
      normalized,
    )
  ) {
    fail(
      "invalid_value",
      path,
      "theme variable network and image functions are not allowed",
    );
  }
}

function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\([0-9A-Fa-f]{1,6})(?:[ \t\r\n\f])?|\\([^\r\n\f0-9A-Fa-f])/g,
    (_match, hexadecimal: string | undefined, escaped: string | undefined) => {
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        if (codePoint === 0 || codePoint > 0x10ffff) return "\uFFFD";
        return String.fromCodePoint(codePoint);
      }
      return escaped ?? "";
    },
  );
}

function assertPublicationEnvelopeLimit(
  value: Record<string, unknown>,
  checkpoint: BrowserGatewayOwnerCheckpoint | null,
): void {
  const envelope = { ...value, checkpoint: null };
  const maximumBytes =
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchBytes;
  assertSerializedLimit(envelope, maximumBytes, "$", "publication envelope");
  if (!checkpoint) return;
  const combinedMaximum =
    maximumBytes +
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointBytes;
  assertSerializedLimit(value, combinedMaximum, "$", "publication request");
}

function assertControlEnvelopeLimit(value: unknown, subject: string): void {
  assertSerializedLimit(
    value,
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerEventPayloadBytes,
    "$",
    subject,
  );
}

function assertSerializedLimit(
  value: unknown,
  maximumBytes: number,
  path: string,
  subject: string,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid_value", path, `${subject} is not JSON serializable`);
  }
  if (serialized === undefined)
    fail("invalid_value", path, `${subject} is not JSON serializable`);
  if (utf8ByteLength(serialized) > maximumBytes) {
    fail("resource_limit", path, `${subject} exceeds ${maximumBytes} bytes`);
  }
}

function fail(
  code: BrowserGatewayProtocolErrorCode,
  path: string,
  message: string,
): never {
  throw new BrowserGatewayProtocolError(code, path, message);
}
