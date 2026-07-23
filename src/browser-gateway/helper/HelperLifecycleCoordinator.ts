import type * as http from "http";
import type * as net from "net";

export type HelperLivenessReason = "browser_stream" | "ask_agent_turn";

export interface HelperTrackedStream {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  once(event: "close" | "error", listener: () => void): unknown;
  off(event: "close" | "error", listener: () => void): unknown;
  end(): unknown;
  destroy(): unknown;
}

export interface HelperLifecycleCoordinatorOptions {
  server: http.Server;
  shutdownTimeoutMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, timeoutMs: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  onLivenessChanged?: (reasons: readonly HelperLivenessReason[]) => void;
}

export interface HelperShutdownHooks {
  drain(signal: AbortSignal): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export interface HelperShutdownResult {
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly destroyedSockets: number;
  readonly destroyedStreams: number;
  readonly drainError?: unknown;
  readonly cleanupError?: unknown;
}

type TrackedStream = {
  readonly stream: HelperTrackedStream;
  readonly close: (() => void) | undefined;
  readonly release: () => void;
};

export class HelperLifecycleCoordinator {
  private readonly server: http.Server;
  private readonly shutdownTimeoutMs: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => NodeJS.Timeout;
  private readonly cancelTimeout: (timer: NodeJS.Timeout) => void;
  private readonly onLivenessChanged:
    | ((reasons: readonly HelperLivenessReason[]) => void)
    | undefined;
  private readonly sockets = new Set<net.Socket>();
  private readonly streams = new Set<TrackedStream>();
  private readonly livenessCounts = new Map<HelperLivenessReason, number>();
  private shutdownPromise: Promise<HelperShutdownResult> | undefined;
  private accepting = true;

  constructor(options: HelperLifecycleCoordinatorOptions) {
    this.server = options.server;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.onLivenessChanged = options.onLivenessChanged;
    this.server.on("connection", this.handleConnection);
  }

  get isShuttingDown(): boolean {
    return this.shutdownPromise !== undefined;
  }

  get acceptedSocketCount(): number {
    return this.sockets.size;
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  getLivenessReasons(): HelperLivenessReason[] {
    return [...this.livenessCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([reason]) => reason)
      .sort();
  }

  hasLivenessReasons(): boolean {
    return this.livenessCounts.size > 0;
  }

  acquireLiveness(reason: HelperLivenessReason): () => void {
    if (this.isShuttingDown) return () => undefined;
    this.livenessCounts.set(reason, (this.livenessCounts.get(reason) ?? 0) + 1);
    this.notifyLivenessChanged();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.livenessCounts.get(reason) ?? 0;
      if (count <= 1) this.livenessCounts.delete(reason);
      else this.livenessCounts.set(reason, count - 1);
      this.notifyLivenessChanged();
    };
  }

  trackStream(
    stream: HelperTrackedStream,
    close?: () => void,
    livenessReason: HelperLivenessReason | null = "browser_stream",
  ): () => void {
    if (this.isShuttingDown) {
      this.closeStream({ stream, close, release: () => undefined }, true);
      return () => undefined;
    }
    const releaseLiveness = livenessReason
      ? this.acquireLiveness(livenessReason)
      : () => undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      stream.off("close", release);
      stream.off("error", release);
      this.streams.delete(tracked);
      releaseLiveness();
    };
    const tracked: TrackedStream = { stream, close, release };
    this.streams.add(tracked);
    stream.once("close", release);
    stream.once("error", release);
    return release;
  }

  shutdown(hooks: HelperShutdownHooks): Promise<HelperShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(hooks);
    return this.shutdownPromise;
  }

  private readonly handleConnection = (socket: net.Socket): void => {
    if (!this.accepting) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  };

  private async performShutdown(
    hooks: HelperShutdownHooks,
  ): Promise<HelperShutdownResult> {
    const startedAt = this.now();
    this.accepting = false;
    this.server.off("connection", this.handleConnection);
    const controller = new AbortController();
    let timedOut = false;
    let destroyedSockets = 0;
    let destroyedStreams = 0;
    let resolveDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => {
      resolveDeadline = resolve;
    });
    const deadlineTimer = this.scheduleTimeout(() => {
      timedOut = true;
      controller.abort();
      destroyedStreams += this.closeTrackedStreams(true);
      destroyedSockets += this.destroyTrackedSockets();
      this.server.closeAllConnections?.();
      resolveDeadline();
    }, this.shutdownTimeoutMs);

    const serverClosed = this.stopAccepting();
    let drainError: unknown;
    const drained = Promise.resolve()
      .then(() => hooks.drain(controller.signal))
      .catch((error) => {
        drainError = error;
      })
      .then(() => {
        if (!timedOut) this.closeTrackedStreams(false);
      });
    let cleanupError: unknown;
    const cleanup = Promise.resolve()
      .then(() => hooks.cleanup())
      .catch((error) => {
        cleanupError = error;
      });

    await Promise.race([
      Promise.all([drained, serverClosed, cleanup]),
      deadline,
    ]);
    if (!timedOut) {
      this.cancelTimeout(deadlineTimer);
      resolveDeadline();
    }

    this.livenessCounts.clear();
    this.notifyLivenessChanged();
    return {
      timedOut,
      durationMs: Math.max(0, this.now() - startedAt),
      destroyedSockets,
      destroyedStreams,
      ...(drainError === undefined ? {} : { drainError }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    };
  }

  private stopAccepting(): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        this.server.close(() => resolve());
        this.server.closeIdleConnections?.();
      } catch {
        resolve();
      }
    });
  }

  private closeTrackedStreams(force: boolean): number {
    let destroyed = 0;
    for (const tracked of this.streams) {
      if (this.closeStream(tracked, force)) destroyed += 1;
    }
    return destroyed;
  }

  private closeStream(tracked: TrackedStream, force: boolean): boolean {
    try {
      tracked.close?.();
    } catch {
      // Force teardown below still owns the final cleanup path.
    }
    const { stream } = tracked;
    if (!force) {
      if (!stream.destroyed && !stream.writableEnded) {
        try {
          stream.end();
        } catch {
          // Deadline teardown will destroy it if it remains tracked.
        }
      }
      return false;
    }
    if (!stream.destroyed) {
      try {
        stream.destroy();
      } catch {
        // Best-effort force teardown.
      }
      tracked.release();
      return true;
    }
    tracked.release();
    return false;
  }

  private destroyTrackedSockets(): number {
    let destroyed = 0;
    for (const socket of this.sockets) {
      if (socket.destroyed) continue;
      try {
        socket.destroy();
        destroyed += 1;
      } catch {
        // Best-effort force teardown.
      }
    }
    return destroyed;
  }

  private notifyLivenessChanged(): void {
    try {
      this.onLivenessChanged?.(this.getLivenessReasons());
    } catch {
      // Observability must not affect lifecycle ownership.
    }
  }
}
