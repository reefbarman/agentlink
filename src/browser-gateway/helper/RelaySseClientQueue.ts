import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "../dataPlane/limits.js";

export interface RelaySseWritable {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: string): boolean;
  end(): unknown;
  destroy(): unknown;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
}

export interface RelaySseFrame {
  readonly data: string;
  readonly byteLength: number;
  readonly relaySequence?: number;
  readonly ownerSequence?: number;
  readonly retainDuringCompaction?: boolean;
}

export interface RelaySseCompactionRequest {
  readonly maximumRelaySequence: number;
  readonly maximumOwnerSequence: number;
}

export interface RelaySseClientQueueOptions {
  readonly writable: RelaySseWritable;
  readonly maxQueuedBytes?: number;
  readonly stallDeadlineMs?: number;
  readonly setTimeout?: (
    callback: () => void,
    timeoutMs: number,
  ) => NodeJS.Timeout;
  readonly clearTimeout?: (timer: NodeJS.Timeout) => void;
  readonly requestCompaction: (request: RelaySseCompactionRequest) => void;
  readonly onClose?: (reason: "closed" | "error" | "stall_deadline") => void;
}

export class RelaySseClientQueue {
  private readonly writable: RelaySseWritable;
  private readonly maxQueuedBytes: number;
  private readonly stallDeadlineMs: number;
  private readonly scheduleTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => NodeJS.Timeout;
  private readonly cancelTimeout: (timer: NodeJS.Timeout) => void;
  private queued: RelaySseFrame[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private compactionRequest: RelaySseCompactionRequest | null = null;
  private compactionNeutralFrames: RelaySseFrame[] = [];
  private compactionNeutralBytes = 0;
  private stallTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RelaySseClientQueueOptions) {
    this.writable = options.writable;
    this.maxQueuedBytes =
      options.maxQueuedBytes ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.browserQueuedSseBytes;
    this.stallDeadlineMs =
      options.stallDeadlineMs ??
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.backpressureStallDeadlineMs;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.writable.once("drain", this.handleDrain);
    this.writable.once("close", this.handleClose);
    this.writable.once("error", this.handleError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isAwaitingCompaction(): boolean {
    return this.compactionRequest !== null;
  }

  get queuedByteLength(): number {
    return this.queuedBytes;
  }

  send(frame: RelaySseFrame): boolean {
    if (this.closed) return false;
    if (this.compactionRequest) {
      if (frame.retainDuringCompaction) {
        this.compactionNeutralFrames.push(frame);
        this.compactionNeutralBytes += frame.byteLength;
        if (this.compactionNeutralBytes > this.maxQueuedBytes) {
          this.finish("error", true);
          return false;
        }
      } else {
        this.expandCompactionRequest(frame);
      }
      return true;
    }
    if (!this.blocked && this.queued.length === 0) {
      try {
        if (!this.writable.write(frame.data)) {
          this.blocked = true;
          this.startStallTimer();
        }
        return true;
      } catch {
        this.finish("error", true);
        return false;
      }
    }
    this.queued.push(frame);
    this.queuedBytes += frame.byteLength;
    if (this.queuedBytes > this.maxQueuedBytes) this.beginCompaction();
    return true;
  }

  replacePending(frames: readonly RelaySseFrame[]): void {
    if (this.closed) return;
    this.compactionRequest = null;
    this.compactionNeutralFrames = [];
    this.compactionNeutralBytes = 0;
    this.queued = [...frames];
    this.queuedBytes = frames.reduce(
      (total, frame) => total + frame.byteLength,
      0,
    );
    if (!this.blocked) this.flush();
  }

  installCompaction(
    checkpointOwnerSequence: number,
    frames: readonly RelaySseFrame[],
  ): boolean {
    const request = this.compactionRequest;
    if (!request) return false;
    if (checkpointOwnerSequence < request.maximumOwnerSequence) {
      this.options.requestCompaction(request);
      return false;
    }
    this.compactionRequest = null;
    this.queued = [...frames, ...this.compactionNeutralFrames];
    this.queuedBytes =
      frames.reduce((total, frame) => total + frame.byteLength, 0) +
      this.compactionNeutralBytes;
    this.compactionNeutralFrames = [];
    this.compactionNeutralBytes = 0;
    if (!this.blocked) this.flush();
    return true;
  }

  close(force = false): void {
    if (this.closed) return;
    this.finish("closed", force);
  }

  private beginCompaction(): void {
    const request = this.queued.reduce<RelaySseCompactionRequest>(
      (current, frame) => {
        if (frame.retainDuringCompaction) return current;
        return {
          maximumRelaySequence: Math.max(
            current.maximumRelaySequence,
            frame.relaySequence ?? 0,
          ),
          maximumOwnerSequence: Math.max(
            current.maximumOwnerSequence,
            frame.ownerSequence ?? 0,
          ),
        };
      },
      { maximumRelaySequence: 0, maximumOwnerSequence: 0 },
    );
    this.compactionNeutralFrames = this.queued.filter(
      (frame) => frame.retainDuringCompaction,
    );
    this.compactionNeutralBytes = this.compactionNeutralFrames.reduce(
      (total, frame) => total + frame.byteLength,
      0,
    );
    this.compactionRequest = request;
    this.queued = [];
    this.queuedBytes = 0;
    this.options.requestCompaction(request);
  }

  private expandCompactionRequest(frame: RelaySseFrame): void {
    const current = this.compactionRequest;
    if (!current) return;
    this.compactionRequest = {
      maximumRelaySequence: Math.max(
        current.maximumRelaySequence,
        frame.relaySequence ?? 0,
      ),
      maximumOwnerSequence: Math.max(
        current.maximumOwnerSequence,
        frame.ownerSequence ?? 0,
      ),
    };
  }

  private readonly handleDrain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    this.stopStallTimer();
    this.writable.once("drain", this.handleDrain);
    this.flush();
  };

  private flush(): void {
    while (!this.closed && !this.blocked && this.queued.length > 0) {
      const frame = this.queued.shift()!;
      this.queuedBytes -= frame.byteLength;
      try {
        if (!this.writable.write(frame.data)) {
          this.blocked = true;
          this.startStallTimer();
        }
      } catch {
        this.finish("error", true);
      }
    }
  }

  private startStallTimer(): void {
    if (this.stallTimer) return;
    this.stallTimer = this.scheduleTimeout(() => {
      this.stallTimer = undefined;
      this.finish("stall_deadline", true);
    }, this.stallDeadlineMs);
    this.stallTimer.unref?.();
  }

  private stopStallTimer(): void {
    if (!this.stallTimer) return;
    this.cancelTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private readonly handleClose = (): void => {
    this.finish("closed", false);
  };

  private readonly handleError = (): void => {
    this.finish("error", true);
  };

  private finish(
    reason: "closed" | "error" | "stall_deadline",
    force: boolean,
  ): void {
    if (this.closed) return;
    this.closed = true;
    this.stopStallTimer();
    this.writable.off("drain", this.handleDrain);
    this.writable.off("close", this.handleClose);
    this.writable.off("error", this.handleError);
    this.queued = [];
    this.queuedBytes = 0;
    this.compactionRequest = null;
    this.compactionNeutralFrames = [];
    this.compactionNeutralBytes = 0;
    try {
      if (force) this.writable.destroy();
      else if (!this.writable.destroyed && !this.writable.writableEnded) {
        this.writable.end();
      }
    } catch {
      // Best-effort teardown; lifecycle owns final socket destruction.
    }
    this.options.onClose?.(reason);
  }
}

export function createRelaySseFrame(params: {
  event: string;
  data: unknown;
  id?: number | string;
  relaySequence?: number;
  ownerSequence?: number;
  retainDuringCompaction?: boolean;
}): RelaySseFrame {
  const serialized = JSON.stringify(params.data);
  const data = `${params.id === undefined ? "" : `id: ${params.id}\n`}event: ${params.event}\ndata: ${serialized}\n\n`;
  return {
    data,
    byteLength: Buffer.byteLength(data),
    ...(params.relaySequence === undefined
      ? {}
      : { relaySequence: params.relaySequence }),
    ...(params.ownerSequence === undefined
      ? {}
      : { ownerSequence: params.ownerSequence }),
    ...(params.retainDuringCompaction === undefined
      ? {}
      : { retainDuringCompaction: params.retainDuringCompaction }),
  };
}
