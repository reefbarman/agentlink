import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../../dataPlane/limits";
import {
  type BrowserGatewayOperationState,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayTranscriptMessage,
  type BrowserGatewayTranscriptWindow,
} from "../../dataPlane/protocol";

export interface RelayCatalogOwner {
  ownerId: string;
  ownerGenerationId: string;
  ownerKind: string;
  displayName: string;
  instanceId?: string;
  scope:
    | { kind: "workspace"; workspaceId: string; displayName: string }
    | { kind: "projectless"; scopeId: string; displayName: string };
  status: string;
  capabilities: Array<{
    capabilityId: string;
    state: "enabled" | "disabled" | "requires_approval" | "unavailable";
    reason?: string;
  }>;
  lastHeartbeatAt: number | null;
}

export interface RelayCheckpointRecord {
  kind: "checkpoint";
  relaySequence: number;
  ownerSequence: number;
  checkpoint: BrowserGatewayOwnerCheckpoint;
}

export interface RelayEventRecord {
  kind: "event";
  relaySequence: number;
  ownerSequence: number;
  event: BrowserGatewayOwnerEvent;
}

export type RelayOwnerStoreApplyResult =
  | { status: "applied"; checkpoint: BrowserGatewayOwnerCheckpoint }
  | { status: "duplicate"; checkpoint: BrowserGatewayOwnerCheckpoint }
  | {
      status: "checkpoint_required";
      reason:
        | "helper_generation_changed"
        | "owner_generation_changed"
        | "sequence_gap"
        | "invalid_owner_state";
    };

export interface RelayOwnerStoreOptions {
  maximumOwners?: number;
  maximumEstimatedBytes?: number;
  now?: () => number;
}

type OwnerState = {
  ownerId: string;
  ownerGenerationId: string;
  checkpoint: BrowserGatewayOwnerCheckpoint;
  relaySequence: number;
  ownerSequence: number;
  estimatedBytes: number;
  lastAccessedAt: number;
};

const DEFAULT_MAXIMUM_OWNERS =
  BROWSER_GATEWAY_DATA_PLANE_LIMITS.cachedBrowserOwners;
const DEFAULT_MAXIMUM_ESTIMATED_BYTES =
  BROWSER_GATEWAY_DATA_PLANE_LIMITS.cachedBrowserOwnerBytes;

export class RelayOwnerStore {
  private readonly states = new Map<string, OwnerState>();
  private readonly catalog = new Map<string, RelayCatalogOwner>();
  private readonly maximumOwners: number;
  private readonly maximumEstimatedBytes: number;
  private readonly now: () => number;
  private helperGenerationId: string | null = null;
  private accessSequence = 0;

  constructor(options: RelayOwnerStoreOptions = {}) {
    this.maximumOwners = options.maximumOwners ?? DEFAULT_MAXIMUM_OWNERS;
    this.maximumEstimatedBytes =
      options.maximumEstimatedBytes ?? DEFAULT_MAXIMUM_ESTIMATED_BYTES;
    this.now = options.now ?? Date.now;
  }

  bindHelperGeneration(helperGenerationId: string): boolean {
    if (this.helperGenerationId === helperGenerationId) return false;
    this.helperGenerationId = helperGenerationId;
    this.states.clear();
    this.catalog.clear();
    return true;
  }

  setCatalog(
    helperGenerationId: string,
    owners: readonly RelayCatalogOwner[],
  ): boolean {
    const changedGeneration = this.bindHelperGeneration(helperGenerationId);
    const previous = JSON.stringify([...this.catalog.values()]);
    this.catalog.clear();
    for (const owner of owners) this.catalog.set(owner.ownerId, owner);
    for (const [key, state] of this.states) {
      const owner = this.catalog.get(state.ownerId);
      if (!owner || owner.ownerGenerationId !== state.ownerGenerationId) {
        this.states.delete(key);
      }
    }
    return changedGeneration || previous !== JSON.stringify(owners);
  }

  getCatalog(): readonly RelayCatalogOwner[] {
    return [...this.catalog.values()];
  }

  getOwner(ownerId: string): RelayCatalogOwner | undefined {
    return this.catalog.get(ownerId);
  }

  getCheckpoint(
    ownerId: string,
    ownerGenerationId?: string,
  ): BrowserGatewayOwnerCheckpoint | null {
    const generation =
      ownerGenerationId ?? this.catalog.get(ownerId)?.ownerGenerationId;
    if (!generation) return null;
    const state = this.states.get(ownerKey(ownerId, generation));
    if (!state) return null;
    this.touch(state);
    return state.checkpoint;
  }

  getCursor(ownerId: string, ownerGenerationId: string): string | null {
    const state = this.states.get(ownerKey(ownerId, ownerGenerationId));
    if (!state || !this.helperGenerationId) return null;
    return [
      this.helperGenerationId,
      encodeURIComponent(ownerId),
      encodeURIComponent(ownerGenerationId),
      state.relaySequence,
    ].join("/");
  }

  invalidate(ownerId: string, ownerGenerationId?: string): void {
    if (ownerGenerationId) {
      this.states.delete(ownerKey(ownerId, ownerGenerationId));
      return;
    }
    for (const [key, state] of this.states) {
      if (state.ownerId === ownerId) this.states.delete(key);
    }
  }

  applyCheckpoint(
    helperGenerationId: string,
    record: RelayCheckpointRecord,
  ): RelayOwnerStoreApplyResult {
    if (this.bindHelperGeneration(helperGenerationId)) {
      // The incoming checkpoint establishes the first state in the new generation.
    }
    const checkpoint = record.checkpoint;
    if (
      checkpoint.helperGenerationId !== helperGenerationId ||
      checkpoint.ownerId === "" ||
      checkpoint.ownerGenerationId === "" ||
      checkpoint.checkpointSequence !== record.ownerSequence
    ) {
      return { status: "checkpoint_required", reason: "invalid_owner_state" };
    }
    const key = ownerKey(checkpoint.ownerId, checkpoint.ownerGenerationId);
    const current = this.states.get(key);
    if (current && record.ownerSequence <= current.ownerSequence) {
      this.touch(current);
      return { status: "duplicate", checkpoint: current.checkpoint };
    }
    if (current && record.relaySequence <= current.relaySequence) {
      return { status: "checkpoint_required", reason: "invalid_owner_state" };
    }
    if (
      [...this.states.values()].some(
        (state) =>
          state.ownerId === checkpoint.ownerId &&
          state.ownerGenerationId !== checkpoint.ownerGenerationId,
      )
    ) {
      this.invalidate(checkpoint.ownerId);
    }
    const state: OwnerState = {
      ownerId: checkpoint.ownerId,
      ownerGenerationId: checkpoint.ownerGenerationId,
      checkpoint,
      relaySequence: record.relaySequence,
      ownerSequence: record.ownerSequence,
      estimatedBytes: estimateBytes(checkpoint),
      lastAccessedAt: this.nextAccessTime(),
    };
    this.states.set(key, state);
    this.prune(key);
    return { status: "applied", checkpoint };
  }

  applyEvent(
    helperGenerationId: string,
    record: RelayEventRecord,
  ): RelayOwnerStoreApplyResult {
    if (this.helperGenerationId !== helperGenerationId) {
      this.bindHelperGeneration(helperGenerationId);
      return {
        status: "checkpoint_required",
        reason: "helper_generation_changed",
      };
    }
    const event = record.event;
    if (
      event.helperGenerationId !== helperGenerationId ||
      event.ownerSequence !== record.ownerSequence
    ) {
      return { status: "checkpoint_required", reason: "invalid_owner_state" };
    }
    const key = ownerKey(event.ownerId, event.ownerGenerationId);
    const state = this.states.get(key);
    if (!state) {
      const hasOtherGeneration = [...this.states.values()].some(
        (candidate) => candidate.ownerId === event.ownerId,
      );
      return {
        status: "checkpoint_required",
        reason: hasOtherGeneration
          ? "owner_generation_changed"
          : "invalid_owner_state",
      };
    }
    if (record.ownerSequence <= state.ownerSequence) {
      this.touch(state);
      return { status: "duplicate", checkpoint: state.checkpoint };
    }
    if (record.relaySequence <= state.relaySequence) {
      return { status: "checkpoint_required", reason: "invalid_owner_state" };
    }
    if (record.ownerSequence !== state.ownerSequence + 1) {
      return { status: "checkpoint_required", reason: "sequence_gap" };
    }

    const checkpoint = applyOwnerEvent(state.checkpoint, event);
    if (!checkpoint) {
      return { status: "checkpoint_required", reason: "invalid_owner_state" };
    }
    state.checkpoint = checkpoint;
    state.ownerSequence = record.ownerSequence;
    state.relaySequence = record.relaySequence;
    state.estimatedBytes = estimateBytes(checkpoint);
    this.touch(state);
    this.prune(key);
    return { status: "applied", checkpoint };
  }

  private touch(state: OwnerState): void {
    state.lastAccessedAt = this.nextAccessTime();
    const key = ownerKey(state.ownerId, state.ownerGenerationId);
    this.states.delete(key);
    this.states.set(key, state);
  }

  private nextAccessTime(): number {
    this.accessSequence += 1;
    return Math.max(this.now(), this.accessSequence);
  }

  private prune(protectedKey: string): void {
    let totalBytes = [...this.states.values()].reduce(
      (total, state) => total + state.estimatedBytes,
      0,
    );
    while (
      this.states.size > this.maximumOwners ||
      totalBytes > this.maximumEstimatedBytes
    ) {
      const candidate = [...this.states.entries()]
        .filter(([key]) => key !== protectedKey)
        .sort(
          (left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
        )[0];
      if (!candidate) break;
      this.states.delete(candidate[0]);
      totalBytes -= candidate[1].estimatedBytes;
    }
  }
}

function applyOwnerEvent(
  current: BrowserGatewayOwnerCheckpoint,
  event: BrowserGatewayOwnerEvent,
): BrowserGatewayOwnerCheckpoint | null {
  if (
    current.helperGenerationId !== event.helperGenerationId ||
    current.ownerId !== event.ownerId ||
    current.ownerGenerationId !== event.ownerGenerationId
  ) {
    return null;
  }
  const next: BrowserGatewayOwnerCheckpoint = {
    ...current,
    checkpointSequence: event.ownerSequence,
    emittedAt: event.emittedAt,
  };
  const payload = event.payload as unknown as Record<string, unknown>;
  switch (event.kind) {
    case "foreground.control.updated":
      next.foreground =
        payload.foreground as BrowserGatewayOwnerCheckpoint["foreground"];
      break;
    case "session.catalog.updated":
      next.catalog =
        payload.catalog as BrowserGatewayOwnerCheckpoint["catalog"];
      break;
    case "transcript.message.appended": {
      const message = payload.message as BrowserGatewayTranscriptMessage;
      if (
        current.transcript.messages.some(
          (candidate) => candidate.messageId === message.messageId,
        )
      ) {
        return null;
      }
      next.transcript = {
        ...current.transcript,
        messages: [...current.transcript.messages, message],
      };
      break;
    }
    case "transcript.message.upserted": {
      const message = payload.message as BrowserGatewayTranscriptMessage;
      const index = current.transcript.messages.findIndex(
        (candidate) => candidate.messageId === message.messageId,
      );
      // Revisions are content hashes, not monotonic counters. Event sequences
      // establish order; revision equality only rejects unchanged content.
      if (
        index >= 0 &&
        message.revision === current.transcript.messages[index]!.revision
      ) {
        return null;
      }
      const messages = [...current.transcript.messages];
      if (index < 0) messages.push(message);
      else messages[index] = message;
      next.transcript = { ...current.transcript, messages };
      break;
    }
    case "transcript.block.delta": {
      const updated = applyTranscriptDelta(current.transcript, payload);
      if (!updated) return null;
      next.transcript = updated;
      break;
    }
    case "transcript.history.prepended": {
      const history = event.payload as BrowserGatewayTranscriptWindow;
      const currentIds = new Set(
        current.transcript.messages.map((message) => message.messageId),
      );
      if (
        history.messages.some((message) => currentIds.has(message.messageId))
      ) {
        return null;
      }
      next.transcript = {
        messages: [...history.messages, ...current.transcript.messages],
        earlierCursor: history.earlierCursor,
        hasEarlier: history.hasEarlier,
      };
      break;
    }
    case "interaction.updated":
      next.ui = {
        ...current.ui,
        interaction:
          payload.interaction as BrowserGatewayOwnerCheckpoint["ui"]["interaction"],
      };
      break;
    case "queue.updated":
      next.ui = {
        ...current.ui,
        queue: payload.queue as BrowserGatewayOwnerCheckpoint["ui"]["queue"],
      };
      break;
    case "todo.updated":
      next.ui = {
        ...current.ui,
        todos: payload.todos as BrowserGatewayOwnerCheckpoint["ui"]["todos"],
      };
      break;
    case "background.updated":
      next.background =
        payload.sessions as BrowserGatewayOwnerCheckpoint["background"];
      break;
    case "fleet.updated":
      next.fleet = payload.sessions as BrowserGatewayOwnerCheckpoint["fleet"];
      break;
    case "diff.preview.updated":
      next.diffs = payload.diffs as BrowserGatewayOwnerCheckpoint["diffs"];
      break;
    case "repository.updated":
      next.repository =
        payload.repository as BrowserGatewayOwnerCheckpoint["repository"];
      break;
    case "theme.updated":
      next.theme = payload.theme as BrowserGatewayOwnerCheckpoint["theme"];
      break;
    case "model_catalog.revision.updated":
      next.modelCatalogRevision = payload.revision as string;
      break;
    case "owner.capabilities.updated":
      next.capabilities =
        payload.capabilities as BrowserGatewayOwnerCheckpoint["capabilities"];
      break;
    case "operation.updated": {
      const operation = payload.operation as BrowserGatewayOperationState;
      const operations = [...current.ui.operations];
      const index = operations.findIndex(
        (candidate) => candidate.operationId === operation.operationId,
      );
      if (index < 0) operations.push(operation);
      else operations[index] = operation;
      next.ui = { ...current.ui, operations };
      break;
    }
  }
  return next;
}

function applyTranscriptDelta(
  transcript: BrowserGatewayTranscriptWindow,
  payload: Record<string, unknown>,
): BrowserGatewayTranscriptWindow | null {
  const messageId = payload.messageId;
  const blockId = payload.blockId;
  const field = payload.field;
  const delta = payload.delta;
  const revision = payload.revision;
  if (
    typeof messageId !== "string" ||
    typeof blockId !== "string" ||
    (field !== "text" && field !== "thinking") ||
    typeof delta !== "string" ||
    typeof revision !== "number"
  ) {
    return null;
  }
  const messageIndex = transcript.messages.findIndex(
    (message) => message.messageId === messageId,
  );
  if (messageIndex < 0) return null;
  const message = transcript.messages[messageIndex]!;
  // Revisions are content hashes; only equality indicates a duplicate.
  if (revision === message.revision) return null;
  const blockIndex = message.blocks.findIndex(
    (block) => block.blockId === blockId,
  );
  if (blockIndex < 0) return null;
  const block = message.blocks[blockIndex]!;
  if (
    (field === "text" && block.type !== "text") ||
    (field === "thinking" && block.type !== "thinking") ||
    (block.type !== "text" && block.type !== "thinking") ||
    block.text.kind !== "inline"
  ) {
    return null;
  }
  const blocks = [...message.blocks];
  blocks[blockIndex] = {
    ...block,
    text: { kind: "inline", text: block.text.text + delta },
  };
  const messages = [...transcript.messages];
  messages[messageIndex] = { ...message, revision, blocks };
  return { ...transcript, messages };
}

function ownerKey(ownerId: string, ownerGenerationId: string): string {
  return `${ownerId}\u0000${ownerGenerationId}`;
}

function estimateBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
