import {
  BROWSER_GATEWAY_DATA_PLANE_LIMITS,
  browserGatewayDetailResponseByteLimit,
} from "../dataPlane/limits.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  parseBrowserGatewayOwnerPublicationBatch,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerEvent,
  type BrowserGatewayRelayResetReason,
} from "../dataPlane/protocol.js";

export interface BrowserGatewayRelayCheckpointRecord {
  readonly kind: "checkpoint";
  readonly relaySequence: number;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly ownerSequence: number;
  readonly emittedAt: number;
  readonly checkpoint: BrowserGatewayOwnerCheckpoint;
}

export interface BrowserGatewayRelayEventRecord {
  readonly kind: "event";
  readonly relaySequence: number;
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly ownerSequence: number;
  readonly emittedAt: number;
  readonly event: BrowserGatewayOwnerEvent;
}

export type BrowserGatewayRelayRecord =
  | BrowserGatewayRelayCheckpointRecord
  | BrowserGatewayRelayEventRecord;

export interface BrowserGatewayRelayStorePublication {
  readonly ownerId: string;
  readonly ownerGenerationId: string;
  readonly records: readonly BrowserGatewayRelayRecord[];
}

export type BrowserGatewayRelayReplayResult =
  | {
      readonly kind: "replay";
      readonly latestRelaySequence: number;
      readonly records: readonly BrowserGatewayRelayRecord[];
    }
  | {
      readonly kind: "reset";
      readonly reason: BrowserGatewayRelayResetReason;
      readonly latestRelaySequence: number;
      readonly checkpoint: BrowserGatewayRelayCheckpointRecord | null;
      readonly records: readonly BrowserGatewayRelayEventRecord[];
    };

export interface BrowserGatewayRelayDetail {
  readonly handle: BrowserGatewayDetailHandle;
  readonly content: Buffer;
}

export interface OwnerRelayStoreOptions {
  readonly helperGenerationId: string;
  readonly now?: () => number;
  readonly retainedReplayBytesPerOwnerGeneration?: number;
  readonly retainedReplayEventsPerOwnerGeneration?: number;
  readonly retainedReplayAgeMs?: number;
  readonly aggregateHelperReplayBytes?: number;
  readonly authenticatedDetailResponseBytes?: number;
  readonly authenticatedSessionDetailResponseBytes?: number;
  readonly authenticatedDetailStoreBytes?: number;
}

type StoredReplayRecord = {
  readonly record: BrowserGatewayRelayEventRecord;
  readonly byteLength: number;
};

type OwnerGenerationRelayState = {
  checkpoint: BrowserGatewayRelayCheckpointRecord | null;
  checkpointBytes: number;
  replay: StoredReplayRecord[];
  replayBytes: number;
  replayFloorSequence: number;
  latestRelaySequence: number;
};

type StoredDetail = BrowserGatewayRelayDetail & {
  readonly storedAt: number;
};

function ownerKey(ownerId: string, ownerGenerationId: string): string {
  return `${ownerId}\u0000${ownerGenerationId}`;
}

function detailKey(handle: {
  ownerId: string;
  ownerGenerationId: string;
  handleId: string;
}): string {
  return `${ownerKey(handle.ownerId, handle.ownerGenerationId)}\u0000${handle.handleId}`;
}

export class OwnerRelayStore {
  private readonly generations = new Map<string, OwnerGenerationRelayState>();
  private readonly details = new Map<string, StoredDetail>();
  private readonly listeners = new Set<
    (publication: BrowserGatewayRelayStorePublication) => void
  >();
  private readonly now: () => number;
  private readonly replayBytesPerGeneration: number;
  private readonly replayEventsPerGeneration: number;
  private readonly replayAgeMs: number;
  private readonly aggregateReplayBytes: number;
  private readonly detailResponseBytes: number;
  private readonly sessionDetailResponseBytes: number;
  private readonly detailStoreBytes: number;
  private nextRelaySequence = 1;
  private totalReplayBytes = 0;
  private totalDetailBytes = 0;

  constructor(private readonly options: OwnerRelayStoreOptions) {
    this.now = options.now ?? Date.now;
    this.replayBytesPerGeneration =
      options.retainedReplayBytesPerOwnerGeneration ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.retainedReplayBytesPerOwnerGeneration;
    this.replayEventsPerGeneration =
      options.retainedReplayEventsPerOwnerGeneration ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.retainedReplayEventsPerOwnerGeneration;
    this.replayAgeMs =
      options.retainedReplayAgeMs ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.retainedReplayAgeMs;
    this.aggregateReplayBytes =
      options.aggregateHelperReplayBytes ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.aggregateHelperReplayBytes;
    this.detailResponseBytes =
      options.authenticatedDetailResponseBytes ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes;
    this.sessionDetailResponseBytes =
      options.authenticatedSessionDetailResponseBytes ??
      browserGatewayDetailResponseByteLimit("session");
    this.detailStoreBytes =
      options.authenticatedDetailStoreBytes ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailStoreBytes;
  }

  get latestRelaySequence(): number {
    return this.nextRelaySequence - 1;
  }

  subscribe(
    listener: (publication: BrowserGatewayRelayStorePublication) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingestPublication(value: unknown): BrowserGatewayRelayStorePublication {
    const batch = parseBrowserGatewayOwnerPublicationBatch(value);
    if (batch.helperGenerationId !== this.options.helperGenerationId) {
      throw new Error("browser_gateway_relay_helper_generation_mismatch");
    }
    const key = ownerKey(batch.ownerId, batch.ownerGenerationId);
    const state = this.generations.get(key) ?? {
      checkpoint: null,
      checkpointBytes: 0,
      replay: [],
      replayBytes: 0,
      replayFloorSequence: 0,
      latestRelaySequence: 0,
    };
    const records: BrowserGatewayRelayRecord[] = [];

    if (batch.checkpoint) {
      const checkpoint: BrowserGatewayRelayCheckpointRecord = {
        kind: "checkpoint",
        relaySequence: this.allocateRelaySequence(),
        ownerId: batch.ownerId,
        ownerGenerationId: batch.ownerGenerationId,
        ownerSequence: batch.checkpoint.checkpointSequence,
        emittedAt: batch.checkpoint.emittedAt,
        checkpoint: batch.checkpoint,
      };
      const checkpointBytes = Buffer.byteLength(JSON.stringify(checkpoint));
      this.totalReplayBytes -= state.checkpointBytes;
      state.checkpoint = checkpoint;
      state.checkpointBytes = checkpointBytes;
      this.totalReplayBytes += checkpointBytes;
      state.replayFloorSequence = Math.max(
        state.replayFloorSequence,
        checkpoint.relaySequence,
      );
      records.push(checkpoint);
      this.removeReplayWhere(
        state,
        (entry) => entry.record.ownerSequence <= checkpoint.ownerSequence,
      );
    }

    for (const event of batch.events) {
      const record: BrowserGatewayRelayEventRecord = {
        kind: "event",
        relaySequence: this.allocateRelaySequence(),
        ownerId: batch.ownerId,
        ownerGenerationId: batch.ownerGenerationId,
        ownerSequence: event.ownerSequence,
        emittedAt: event.emittedAt,
        event,
      };
      const byteLength = Buffer.byteLength(JSON.stringify(record));
      state.replay.push({ record, byteLength });
      state.replayBytes += byteLength;
      this.totalReplayBytes += byteLength;
      records.push(record);
    }

    state.latestRelaySequence =
      records.at(-1)?.relaySequence ?? state.latestRelaySequence;
    this.generations.set(key, state);
    this.pruneGeneration(state);
    this.pruneAggregateReplay();

    const publication = {
      ownerId: batch.ownerId,
      ownerGenerationId: batch.ownerGenerationId,
      records,
    } satisfies BrowserGatewayRelayStorePublication;
    for (const listener of this.listeners) {
      try {
        listener(publication);
      } catch {
        // Relay clients are isolated from the transactional owner ingest commit.
      }
    }
    return publication;
  }

  getCheckpoint(
    ownerId: string,
    ownerGenerationId: string,
  ): BrowserGatewayRelayCheckpointRecord | null {
    return (
      this.generations.get(ownerKey(ownerId, ownerGenerationId))?.checkpoint ??
      null
    );
  }

  replay(
    ownerId: string,
    ownerGenerationId: string,
    afterRelaySequence: number | null,
  ): BrowserGatewayRelayReplayResult {
    const state = this.generations.get(ownerKey(ownerId, ownerGenerationId));
    if (!state?.checkpoint) {
      return {
        kind: "reset",
        reason: "checkpoint_required",
        latestRelaySequence:
          state?.latestRelaySequence ?? this.latestRelaySequence,
        checkpoint: null,
        records: [],
      };
    }
    this.pruneGeneration(state);
    const cursor = afterRelaySequence ?? 0;
    if (cursor > this.latestRelaySequence) {
      return {
        kind: "reset",
        reason: "helper_generation_changed",
        latestRelaySequence: this.latestRelaySequence,
        checkpoint: state.checkpoint,
        records: state.replay.map((entry) => entry.record),
      };
    }

    if (cursor > state.latestRelaySequence) {
      return {
        kind: "reset",
        reason: "subscription_changed",
        latestRelaySequence: state.latestRelaySequence,
        checkpoint: state.checkpoint,
        records: state.replay.map((entry) => entry.record),
      };
    }

    if (cursor < state.replayFloorSequence) {
      return {
        kind: "reset",
        reason: cursor === 0 ? "checkpoint_required" : "stale_replay_cursor",
        latestRelaySequence: state.latestRelaySequence,
        checkpoint: state.checkpoint,
        records: state.replay.map((entry) => entry.record),
      };
    }

    return {
      kind: "replay",
      latestRelaySequence: state.latestRelaySequence,
      records: state.replay
        .filter((entry) => entry.record.relaySequence > cursor)
        .map((entry) => entry.record),
    };
  }

  ownerRegistered(ownerId: string, ownerGenerationId: string): void {
    for (const [key, state] of this.generations) {
      if (key === ownerKey(ownerId, ownerGenerationId)) continue;
      if (!key.startsWith(`${ownerId}\u0000`)) continue;
      this.totalReplayBytes -= state.replayBytes + state.checkpointBytes;
      this.generations.delete(key);
    }
    for (const [key, detail] of this.details) {
      if (
        detail.handle.ownerId === ownerId &&
        detail.handle.ownerGenerationId !== ownerGenerationId
      ) {
        this.deleteDetail(key, detail);
      }
    }
  }

  putDetail(handle: BrowserGatewayDetailHandle, content: Uint8Array): void {
    this.pruneDetails();
    if (handle.helperGenerationId !== this.options.helperGenerationId) {
      throw new Error(
        "browser_gateway_relay_detail_helper_generation_mismatch",
      );
    }
    const bytes = Buffer.from(content);
    const maximumBytes =
      handle.kind === "session"
        ? this.sessionDetailResponseBytes
        : this.detailResponseBytes;
    if (
      bytes.byteLength !== handle.byteLength ||
      bytes.byteLength > maximumBytes
    ) {
      throw new Error("browser_gateway_relay_detail_size_mismatch");
    }
    if (handle.expiresAt <= this.now()) {
      throw new Error("browser_gateway_relay_detail_expired");
    }
    const key = detailKey(handle);
    const previous = this.details.get(key);
    if (previous) this.deleteDetail(key, previous);
    const detail: StoredDetail = {
      handle,
      content: bytes,
      storedAt: this.now(),
    };
    this.details.set(key, detail);
    this.totalDetailBytes += bytes.byteLength;
    this.pruneDetailBudget();
  }

  getDetail(params: {
    handleId: string;
    ownerId: string;
    ownerGenerationId: string;
  }): BrowserGatewayRelayDetail | null {
    this.pruneDetails();
    const key = detailKey(params);
    const detail = this.details.get(key);
    if (!detail) return null;
    if (detail.handle.helperGenerationId !== this.options.helperGenerationId) {
      return null;
    }
    this.details.delete(key);
    this.details.set(key, detail);
    return { handle: detail.handle, content: Buffer.from(detail.content) };
  }

  close(): void {
    this.listeners.clear();
    this.generations.clear();
    this.details.clear();
    this.totalReplayBytes = 0;
    this.totalDetailBytes = 0;
  }

  private allocateRelaySequence(): number {
    const sequence = this.nextRelaySequence;
    this.nextRelaySequence += 1;
    return sequence;
  }

  private pruneGeneration(state: OwnerGenerationRelayState): void {
    const minimumEmittedAt = this.now() - this.replayAgeMs;
    while (
      state.replay.length > 0 &&
      (state.replay.length > this.replayEventsPerGeneration ||
        state.replayBytes > this.replayBytesPerGeneration ||
        state.replay[0]!.record.emittedAt < minimumEmittedAt)
    ) {
      this.removeOldestReplay(state);
    }
  }

  private pruneAggregateReplay(): void {
    while (this.totalReplayBytes > this.aggregateReplayBytes) {
      let oldestState: OwnerGenerationRelayState | undefined;
      let oldestRelaySequence = Number.POSITIVE_INFINITY;
      for (const state of this.generations.values()) {
        const sequence = state.replay[0]?.record.relaySequence;
        if (sequence !== undefined && sequence < oldestRelaySequence) {
          oldestState = state;
          oldestRelaySequence = sequence;
        }
      }
      if (oldestState) {
        this.removeOldestReplay(oldestState);
        continue;
      }
      let oldestGenerationKey: string | undefined;
      let oldestGenerationSequence = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.generations) {
        if (state.latestRelaySequence < oldestGenerationSequence) {
          oldestGenerationKey = key;
          oldestGenerationSequence = state.latestRelaySequence;
        }
      }
      if (!oldestGenerationKey) break;
      const evicted = this.generations.get(oldestGenerationKey)!;
      this.totalReplayBytes -= evicted.checkpointBytes + evicted.replayBytes;
      this.generations.delete(oldestGenerationKey);
    }
  }

  private removeReplayWhere(
    state: OwnerGenerationRelayState,
    predicate: (entry: StoredReplayRecord) => boolean,
  ): void {
    const retained: StoredReplayRecord[] = [];
    for (const entry of state.replay) {
      if (predicate(entry)) {
        state.replayBytes -= entry.byteLength;
        this.totalReplayBytes -= entry.byteLength;
      } else {
        retained.push(entry);
      }
    }
    state.replay = retained;
  }

  private removeOldestReplay(state: OwnerGenerationRelayState): void {
    const entry = state.replay.shift();
    if (!entry) return;
    state.replayBytes -= entry.byteLength;
    state.replayFloorSequence = Math.max(
      state.replayFloorSequence,
      entry.record.relaySequence,
    );
    this.totalReplayBytes -= entry.byteLength;
  }

  private pruneDetails(): void {
    const now = this.now();
    for (const [key, detail] of this.details) {
      if (detail.handle.expiresAt <= now) this.deleteDetail(key, detail);
    }
  }

  private pruneDetailBudget(): void {
    while (this.totalDetailBytes > this.detailStoreBytes) {
      const oldest = this.details.entries().next().value as
        | [string, StoredDetail]
        | undefined;
      if (!oldest) break;
      this.deleteDetail(oldest[0], oldest[1]);
    }
  }

  private deleteDetail(key: string, detail: StoredDetail): void {
    if (!this.details.delete(key)) return;
    this.totalDetailBytes -= detail.content.byteLength;
  }
}

export function createRelayReset(params: {
  helperGenerationId: string;
  ownerId: string;
  ownerGenerationId: string;
  reason: BrowserGatewayRelayResetReason;
  latestSequence: number;
  subscriptionId?: string;
}) {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    helperGenerationId: params.helperGenerationId,
    ownerId: params.ownerId,
    ownerGenerationId: params.ownerGenerationId,
    reason: params.reason,
    latestSequence: params.latestSequence,
    ...(params.subscriptionId ? { subscriptionId: params.subscriptionId } : {}),
  } as const;
}
