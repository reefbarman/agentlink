import type * as http from "http";

import { utf8ByteLength } from "../shared/streamingBaselineMetrics.js";

export interface SsePublication<T> {
  readonly revision: number;
  readonly value: T;
  readonly serialized: string;
  readonly bytes: number;
}

export type SseClientRemovalReason =
  | "request_close"
  | "response_close"
  | "response_error"
  | "write_error"
  | "backpressure"
  | "ended"
  | "capture_error"
  | "scheduler_error"
  | "dispose";

export interface SseBroadcastResult {
  readonly attempted: number;
  readonly delivered: number;
}

export interface SseHubOptions<T> {
  readonly serialize: (value: T) => string;
  readonly byteLength?: (serialized: string) => number;
  readonly headers?: http.OutgoingHttpHeaders;
  readonly flushHeaders?: boolean;
  readonly keepaliveIntervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => NodeJS.Timeout;
  readonly clearInterval?: (timer: NodeJS.Timeout) => void;
  readonly onClientCountChanged?: (clientCount: number) => void;
  readonly onClientRemoved?: (reason: SseClientRemovalReason) => void;
  readonly onFirstDelivery?: (sample: {
    durationMs: number;
    bytes: number;
  }) => void;
}

type SseClient<T> = {
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  keepaliveTimer: NodeJS.Timeout | undefined;
  initializing: boolean;
  pendingPublication: SsePublication<T> | undefined;
  readonly captureController: AbortController;
  readonly subscribedAt: number;
  readonly removed: Promise<void>;
  readonly resolveRemoved: () => void;
  removeListeners: () => void;
};

const DEFAULT_HEADERS: http.OutgoingHttpHeaders = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Node SSE client hub for full-state, revisioned publications.
 *
 * Slow clients are disconnected as soon as `ServerResponse.write()` returns
 * false. The hub never queues events while waiting for `drain`; reconnecting
 * clients recover through a new complete initial publication.
 */
export class SseHub<T> {
  private readonly clients = new Map<http.ServerResponse, SseClient<T>>();
  private readonly serialize: (value: T) => string;
  private readonly byteLength: (serialized: string) => number;
  private readonly headers: http.OutgoingHttpHeaders;
  private readonly flushHeaders: boolean;
  private readonly keepaliveIntervalMs: number;
  private readonly now: () => number;
  private readonly scheduleInterval: (
    callback: () => void,
    intervalMs: number,
  ) => NodeJS.Timeout;
  private readonly cancelInterval: (timer: NodeJS.Timeout) => void;
  private readonly onClientCountChanged:
    | ((clientCount: number) => void)
    | undefined;
  private readonly onClientRemoved:
    | ((reason: SseClientRemovalReason) => void)
    | undefined;
  private readonly onFirstDelivery:
    | ((sample: { durationMs: number; bytes: number }) => void)
    | undefined;
  private disposed = false;

  constructor(options: SseHubOptions<T>) {
    this.serialize = options.serialize;
    this.byteLength = options.byteLength ?? utf8ByteLength;
    this.headers = options.headers ?? DEFAULT_HEADERS;
    this.flushHeaders = options.flushHeaders ?? true;
    this.keepaliveIntervalMs =
      options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.scheduleInterval = options.setInterval ?? setInterval;
    this.cancelInterval = options.clearInterval ?? clearInterval;
    this.onClientCountChanged = options.onClientCountChanged;
    this.onClientRemoved = options.onClientRemoved;
    this.onFirstDelivery = options.onFirstDelivery;
  }

  get size(): number {
    return this.clients.size;
  }

  prepare(revision: number, value: T): SsePublication<T> {
    const serialized = this.serialize(value);
    return {
      revision,
      value,
      serialized,
      bytes: this.byteLength(serialized),
    };
  }

  async subscribe(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    captureInitial: (
      signal: AbortSignal,
    ) => SsePublication<T> | Promise<SsePublication<T>>,
  ): Promise<SsePublication<T> | null> {
    if (this.disposed) {
      if (!response.destroyed) response.destroy();
      return null;
    }

    request.socket.setTimeout(0);
    response.socket?.setTimeout(0);
    response.writeHead(200, this.headers);
    if (this.flushHeaders) response.flushHeaders?.();

    const removeForRequestClose = () => this.remove(response, "request_close");
    const removeForResponseClose = () =>
      this.remove(response, "response_close");
    const removeForResponseError = () =>
      this.remove(response, "response_error");
    const captureController = new AbortController();
    let resolveRemoved!: () => void;
    const removed = new Promise<void>((resolve) => {
      resolveRemoved = resolve;
    });
    const client: SseClient<T> = {
      request,
      response,
      keepaliveTimer: undefined,
      initializing: true,
      pendingPublication: undefined,
      captureController,
      subscribedAt: this.now(),
      removed,
      resolveRemoved,
      removeListeners: () => {
        request.off("close", removeForRequestClose);
        response.off("close", removeForResponseClose);
        response.off("error", removeForResponseError);
      },
    };
    this.clients.set(response, client);
    request.on("close", removeForRequestClose);
    response.on("close", removeForResponseClose);
    response.on("error", removeForResponseError);
    this.notifyClientCountChanged();

    let initial: SsePublication<T>;
    try {
      const captured = Promise.resolve(
        captureInitial(captureController.signal),
      );
      const outcome = await Promise.race([
        captured.then((publication) => ({
          kind: "captured" as const,
          publication,
        })),
        removed.then(() => ({ kind: "removed" as const })),
      ]);
      if (outcome.kind === "removed") return null;
      initial = outcome.publication;
    } catch (error) {
      this.remove(response, "capture_error");
      throw error;
    }
    if (!this.clients.has(response)) return null;

    const pending = client.pendingPublication;
    const selected =
      pending && pending.revision > initial.revision ? pending : initial;
    client.initializing = false;
    client.pendingPublication = undefined;

    if (!this.writeEvent(client, "snapshot", selected.serialized)) return null;
    this.notify(() =>
      this.onFirstDelivery?.({
        durationMs: Math.max(0, this.now() - client.subscribedAt),
        bytes: selected.bytes,
      }),
    );

    if (this.keepaliveIntervalMs > 0) {
      try {
        client.keepaliveTimer = this.scheduleInterval(() => {
          // The comment frame keeps proxies from idling the connection; the
          // named event is visible to EventSource so browser clients can
          // detect a wedged origin (comments never reach the JS API).
          this.writeChunk(
            client,
            `: keepalive ${this.now()}\n\n` +
              this.formatEvent("heartbeat", String(this.now())),
          );
        }, this.keepaliveIntervalMs);
      } catch (error) {
        this.remove(response, "scheduler_error");
        throw error;
      }
    }
    return selected;
  }

  broadcast(
    publication: SsePublication<T>,
    event = "update",
  ): SseBroadcastResult {
    if (this.disposed) return { attempted: 0, delivered: 0 };
    const frame = this.formatEvent(event, publication.serialized);
    let attempted = 0;
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.initializing) {
        const pending = client.pendingPublication;
        if (!pending || publication.revision > pending.revision) {
          client.pendingPublication = publication;
        }
        continue;
      }
      attempted += 1;
      if (this.writeChunk(client, frame)) delivered += 1;
    }
    return { attempted, delivered };
  }

  remove(
    response: http.ServerResponse,
    reason: SseClientRemovalReason = "ended",
  ): void {
    const client = this.clients.get(response);
    if (!client) return;
    this.clients.delete(response);
    client.removeListeners();
    client.captureController.abort();
    client.resolveRemoved();
    if (client.keepaliveTimer) {
      this.cancelInterval(client.keepaliveTimer);
      client.keepaliveTimer = undefined;
    }
    const hardTeardown =
      reason === "backpressure" ||
      reason === "write_error" ||
      reason === "response_error";
    if (!response.destroyed && (hardTeardown || !response.writableEnded)) {
      try {
        if (hardTeardown) response.destroy();
        else response.end();
      } catch {
        // Best-effort teardown must not block cleanup of other clients.
      }
    }
    this.notify(() => this.onClientRemoved?.(reason));
    this.notifyClientCountChanged();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const response of this.clients.keys()) {
      this.remove(response, "dispose");
    }
  }

  private writeEvent(
    client: SseClient<T>,
    event: string,
    serialized: string,
  ): boolean {
    return this.writeChunk(client, this.formatEvent(event, serialized));
  }

  private formatEvent(event: string, serialized: string): string {
    if (!event || /[\r\n]/.test(event) || event.includes("\u0000")) {
      throw new Error("invalid_sse_event_name");
    }
    const data = serialized
      .split(/\r\n|\r|\n/)
      .map((line) => `data: ${line}`)
      .join("\n");
    return `event: ${event}\n${data}\n\n`;
  }

  private notifyClientCountChanged(): void {
    this.notify(() => this.onClientCountChanged?.(this.clients.size));
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch {
      // Telemetry observers must not affect connection lifecycle.
    }
  }

  private writeChunk(client: SseClient<T>, chunk: string): boolean {
    const { response } = client;
    if (response.destroyed || response.writableEnded) {
      this.remove(response, "ended");
      return false;
    }
    try {
      if (response.write(chunk)) return true;
      this.remove(response, "backpressure");
      return false;
    } catch {
      this.remove(response, "write_error");
      return false;
    }
  }
}
