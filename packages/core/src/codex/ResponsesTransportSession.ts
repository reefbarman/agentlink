import {
  ResponsesWebSocketConnectError,
  type ResponsesWebSocketConnection,
  type ResponsesWebSocketConnector,
  type ResponsesWebSocketConnectRequest,
} from "./responsesTransport.js";

const SOCKET_IDLE_MS = 60_000;
const SOCKET_MAX_AGE_MS = 55 * 60_000;
const SUPPRESSION_MS = 5 * 60_000;

/** Host-owned, in-memory only. Do not share across windows or principals. */
export class ResponsesTransportPolicy {
  #failures = new Map<string, { count: number; until: number }>();
  #enabled = true;

  observe(enabled: boolean): void {
    if (enabled !== this.#enabled) this.#failures.clear();
    this.#enabled = enabled;
  }

  suppressed(identity: string): boolean {
    const failure = this.#failures.get(identity);
    if (!failure) return false;
    if (failure.until && failure.until <= Date.now()) {
      this.#failures.delete(identity);
      return false;
    }
    return failure.until > Date.now();
  }

  success(identity: string): void {
    this.#failures.delete(identity);
  }

  failure(identity: string): void {
    const count = (this.#failures.get(identity)?.count ?? 0) + 1;
    // Bound private identity retention without persisting credentials.
    if (this.#failures.size >= 128 && !this.#failures.has(identity)) {
      this.#failures.delete(this.#failures.keys().next().value!);
    }
    this.#failures.set(identity, {
      count,
      until: count >= 2 ? Date.now() + SUPPRESSION_MS : 0,
    });
  }
}

/** One active turn, one response at a time, explicitly disposed by its host. */
export class ResponsesTransportSession {
  #connection?: ResponsesWebSocketConnection;
  #identity?: string;
  #openedAt = 0;
  #lastUsedAt = 0;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #disposed = false;
  #httpOnly = false;
  #enabled = true;
  #busy = false;
  #continuation?: {
    properties: string;
    input: unknown[];
    responseId: string;
  };
  #connecting?: AbortController;

  get httpOnly(): boolean {
    return this.#httpOnly;
  }

  assertAvailable(): void {
    if (this.#disposed) throw new Error("Responses transport session disposed");
    if (this.#busy)
      throw new Error("Concurrent Responses requests on one turn");
  }

  configure(enabled: boolean): void {
    if (enabled !== this.#enabled) {
      this.#enabled = enabled;
      this.#httpOnly = false;
      if (!enabled) this.invalidate();
    }
  }

  async connect(
    connector: ResponsesWebSocketConnector,
    request: ResponsesWebSocketConnectRequest,
    identity: string,
  ): Promise<{ connection: ResponsesWebSocketConnection; reused: boolean }> {
    this.assertAvailable();
    clearTimeout(this.#idleTimer);
    this.#busy = true;
    const now = Date.now();
    if (
      this.#identity !== identity ||
      !this.#connection?.isOpen ||
      now - this.#lastUsedAt >= SOCKET_IDLE_MS ||
      now - this.#openedAt >= SOCKET_MAX_AGE_MS
    ) {
      this.invalidate();
      const controller = new AbortController();
      this.#connecting = controller;
      const onAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
      try {
        const connection = await connector.connect({
          ...request,
          signal: controller.signal,
        });
        if (this.#disposed || controller.signal.aborted) {
          connection.close();
          throw new Error("Responses WebSocket connection aborted");
        }
        this.#connection = connection;
        this.#identity = identity;
        this.#openedAt = Date.now();
        return { connection, reused: false };
      } catch (error) {
        this.#busy = false;
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
        this.#connecting = undefined;
      }
    }
    return { connection: this.#connection, reused: true };
  }

  prepareBody(body: Record<string, unknown>): {
    body: Record<string, unknown>;
    incremental: boolean;
  } {
    const { input, previous_response_id: _previous, ...properties } = body;
    const chain = this.#continuation;
    if (
      chain &&
      Array.isArray(input) &&
      chain.properties === stableJson(properties) &&
      input.length >= chain.input.length &&
      chain.input.every(
        (item, index) => stableJson(item) === stableJson(input[index]),
      )
    ) {
      return {
        body: {
          ...properties,
          input: input.slice(chain.input.length),
          previous_response_id: chain.responseId,
        },
        incremental: true,
      };
    }
    this.#continuation = undefined;
    return { body, incremental: false };
  }

  captureCompletion(
    body: Record<string, unknown>,
    event: Record<string, unknown>,
    canonicalOutput?: Record<string, unknown>[],
  ): void {
    const response = event.response as Record<string, unknown> | undefined;
    const output = canonicalOutput ?? response?.output;
    if (
      event.type !== "response.completed" ||
      response?.status === "incomplete" ||
      typeof response?.id !== "string" ||
      !Array.isArray(output) ||
      !Array.isArray(body.input)
    ) {
      this.#continuation = undefined;
      return;
    }
    const { input, previous_response_id: _previous, ...properties } = body;
    const replayBytes = stableJson([input, output]).length;
    if (replayBytes > 5 * 1024 * 1024) {
      this.#continuation = undefined;
      return;
    }
    this.#continuation = {
      properties: stableJson(properties),
      input: structuredClone([...(input as unknown[]), ...output]),
      responseId: response.id,
    };
  }

  release(success: boolean): void {
    this.#busy = false;
    if (!success) {
      this.invalidate();
      return;
    }
    this.#lastUsedAt = Date.now();
    this.#idleTimer = setTimeout(() => this.invalidate(), SOCKET_IDLE_MS);
    this.#idleTimer.unref?.();
  }

  useHttp(): void {
    this.#httpOnly = true;
    this.invalidate();
    this.#busy = false;
  }

  invalidate(): void {
    clearTimeout(this.#idleTimer);
    this.#connecting?.abort();
    this.#connection?.close();
    this.#connection = undefined;
    this.#identity = undefined;
    this.#continuation = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.invalidate();
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

export function isSafeResponsesConnectFallback(error: unknown): boolean {
  return (
    error instanceof ResponsesWebSocketConnectError && error.fallbackAllowed
  );
}
