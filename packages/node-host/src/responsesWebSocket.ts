import WebSocket, { type RawData } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import {
  ResponsesNonReplayableError,
  ResponsesTransportInterruptedError,
  ResponsesWebSocketConnectError,
  ResponsesWebSocketRejectionError,
  type ResponsesWebSocketConnection,
  type ResponsesWebSocketConnector,
  type ResponsesWebSocketConnectRequest,
  type ResponsesWebSocketDispatchRequest,
} from "@agentlink/core/codex";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 128;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const RESPONSE_IDLE_MS = 300_000;
const CLOSE_TIMEOUT_MS = 250;
const FIRST_PARTY_HOSTS = new Set(["api.openai.com", "chatgpt.com"]);
const VERIFIED_REJECTIONS = new Set([
  "previous_response_not_found",
  "context_length_exceeded",
  "context_window_exceeded",
  "invalid_request_error",
  "invalid_model",
  "model_not_found",
  "authentication_error",
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "usage_limit_reached",
  "unsupported_value",
  "unsupported_parameter",
  "service_tier_not_available",
  "routing_not_supported",
  "unsupported_endpoint",
]);
const VERIFIED_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 409, 422, 429,
]);

type WebSocketConstructor = typeof WebSocket;

export interface ResponsesWebSocketConnectorOptions {
  WebSocket?: WebSocketConstructor;
  getProxyForUrl?: typeof getProxyForUrl;
}

function headersFromIncoming(
  values: Record<string, string | string[] | undefined>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

function isFirstPartyResponsesUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "wss:" &&
      FIRST_PARTY_HOSTS.has(url.hostname.toLowerCase()) &&
      ((url.hostname === "api.openai.com" &&
        url.pathname === "/v1/responses") ||
        (url.hostname === "chatgpt.com" &&
          url.pathname === "/backend-api/codex/responses")) &&
      (!url.port || url.port === "443") &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function eventType(event: Record<string, unknown>): string | undefined {
  return typeof event.type === "string" ? event.type : undefined;
}

function terminalType(type: string | undefined): boolean {
  return (
    type === "response.completed" ||
    type === "response.incomplete" ||
    type === "response.failed"
  );
}

function errorFields(event: Record<string, unknown>): {
  message: string;
  code?: string;
  status?: number;
  body: unknown;
} {
  const raw =
    event.error && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : event;
  const statusValue = event.status ?? event.status_code ?? raw.status;
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const code =
    typeof raw.code === "string"
      ? raw.code
      : typeof raw.type === "string"
        ? raw.type
        : undefined;
  return {
    message:
      typeof raw.message === "string"
        ? raw.message
        : "Responses WebSocket request failed",
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    body: event,
  };
}

function verifiedRejection(
  code: string | undefined,
  status: number | undefined,
): boolean {
  return Boolean(
    code &&
    VERIFIED_REJECTIONS.has(code) &&
    (status === undefined || VERIFIED_REJECTION_STATUSES.has(status)),
  );
}

class NodeResponsesWebSocketConnection implements ResponsesWebSocketConnection {
  readonly headers: Headers;
  private closed = false;
  private dispatching = false;
  private activeAbort?: () => void;

  constructor(
    private readonly socket: WebSocket,
    headers: Headers,
  ) {
    this.headers = headers;
    // Idle control messages cannot become the next response's events.
    socket.on("message", () => {
      if (!this.dispatching) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  async *dispatch(
    request: ResponsesWebSocketDispatchRequest,
  ): AsyncIterable<Record<string, unknown>> {
    if (this.dispatching)
      throw new ResponsesNonReplayableError(
        new Error("Responses WebSocket already has an active request"),
      );
    if (!this.isOpen) throw new ResponsesTransportInterruptedError();
    if (request.signal?.aborted) throw abortError(request.signal);
    this.dispatching = true;
    request.evidence.transport = "websocket";
    request.evidence.phase = "not_sent";
    request.evidence.verifiedRejection = undefined;
    const queue: Array<{ event: Record<string, unknown>; bytes: number }> = [];
    let queuedBytes = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const armIdleDeadline = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (ended) return;
        failure = new ResponsesTransportInterruptedError(
          new Error("Responses WebSocket idle timeout"),
        );
        ended = true;
        notify();
        this.close();
      }, RESPONSE_IDLE_MS);
      idleTimer.unref?.();
    };
    const onHeartbeat = () =>
      request.onTransportActivity?.({ kind: "websocket", at: Date.now() });
    const onMessage = (data: RawData) => {
      if (ended || this.closed) return;
      try {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : Buffer.from(data as ArrayBuffer).toString("utf8");
        const event = JSON.parse(text) as Record<string, unknown>;
        if (!event || typeof event !== "object" || Array.isArray(event))
          throw new Error("Invalid event");
        const type = eventType(event);
        if (!type) throw new Error("Missing event type");
        request.onTransportActivity?.({
          kind: "websocket",
          at: Date.now(),
          bytes: Buffer.byteLength(text),
        });
        if (type === "error") {
          const details = errorFields(event);
          const verified =
            request.evidence.phase === "sent_unacknowledged" &&
            verifiedRejection(details.code, details.status);
          request.evidence.phase = verified
            ? "terminal"
            : request.evidence.phase;
          request.evidence.verifiedRejection = verified;
          failure = new ResponsesWebSocketRejectionError(
            details.message,
            details.status,
            details.code,
            headersFromIncoming(
              (event.headers ?? {}) as Record<string, string>,
            ),
            details.body,
            verified,
          );
          ended = true;
          notify();
          return;
        }
        const bytes = Buffer.byteLength(text);
        if (
          queue.length >= MAX_QUEUED_EVENTS ||
          queuedBytes + bytes > MAX_QUEUED_BYTES
        )
          throw new Error("Responses WebSocket event queue overflow");
        queuedBytes += bytes;
        queue.push({ event, bytes });
        armIdleDeadline();
        if (type.startsWith("response.")) {
          if (request.evidence.phase === "sent_unacknowledged")
            request.evidence.phase = "response_started";
        }
        if (terminalType(type)) {
          request.evidence.phase = "terminal";
          request.evidence.terminalFailure = type === "response.failed";
          ended = true;
        }
        notify();
      } catch (error) {
        failure = new ResponsesNonReplayableError(error);
        ended = true;
        notify();
        this.close();
      }
    };
    const onClose = () => {
      if (ended) return;
      failure = request.signal?.aborted
        ? abortError(request.signal)
        : new ResponsesTransportInterruptedError();
      ended = true;
      notify();
    };
    const onError = (error: Error) => {
      if (ended) return;
      failure = request.signal?.aborted
        ? abortError(request.signal)
        : new ResponsesTransportInterruptedError(error);
      ended = true;
      notify();
    };
    const onAbort = () => {
      if (ended) return;
      failure = abortError(request.signal);
      ended = true;
      notify();
      this.close();
    };
    this.activeAbort = onAbort;
    this.socket.on("message", onMessage);
    this.socket.once("close", onClose);
    this.socket.once("error", onError);
    this.socket.on("ping", onHeartbeat);
    this.socket.on("pong", onHeartbeat);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (!this.isOpen) throw new ResponsesTransportInterruptedError();
      request.evidence.phase = "sent_unacknowledged";
      armIdleDeadline();
      try {
        this.socket.send(
          JSON.stringify({ type: "response.create", ...request.body }),
          (error?: Error) => {
            if (error && !ended) {
              failure = new ResponsesTransportInterruptedError(error);
              ended = true;
              notify();
            }
          },
        );
      } catch (error) {
        failure = new ResponsesTransportInterruptedError(error);
        ended = true;
      }
      while (queue.length || !ended) {
        if (queue.length) {
          const queued = queue.shift()!;
          queuedBytes -= queued.bytes;
          const event = queued.event;
          yield event;
          if (terminalType(eventType(event))) return;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    } finally {
      clearTimeout(idleTimer);
      this.socket.off("ping", onHeartbeat);
      this.socket.off("pong", onHeartbeat);
      this.socket.off("message", onMessage);
      this.socket.off("close", onClose);
      this.socket.off("error", onError);
      request.signal?.removeEventListener("abort", onAbort);
      this.activeAbort = undefined;
      this.dispatching = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeAbort?.();
    if (this.socket.readyState === this.socket.CLOSED) return;
    try {
      this.socket.close(1000, "Request complete");
    } catch {
      this.socket.terminate();
      return;
    }
    const timer = setTimeout(() => this.socket.terminate(), CLOSE_TIMEOUT_MS);
    timer.unref?.();
    this.socket.once("close", () => clearTimeout(timer));
  }
}

export function createResponsesWebSocketConnector(
  options: ResponsesWebSocketConnectorOptions = {},
): ResponsesWebSocketConnector {
  const Socket = options.WebSocket ?? WebSocket;
  const proxyResolver = options.getProxyForUrl ?? getProxyForUrl;
  return {
    async connect(
      request: ResponsesWebSocketConnectRequest,
    ): Promise<ResponsesWebSocketConnection> {
      if (!isFirstPartyResponsesUrl(request.url)) {
        throw new ResponsesWebSocketConnectError(
          "WebSocket endpoint is not an approved first-party Responses URL",
          false,
        );
      }
      if (request.signal?.aborted) throw abortError(request.signal);
      const startedAt = Date.now();
      const httpsUrl = new URL(request.url.replace(/^wss:/, "https:"));
      const httpUrl = new URL(httpsUrl);
      httpUrl.protocol = "http:";
      httpUrl.port = "443";
      const proxyUrl =
        proxyResolver(httpsUrl.href) || proxyResolver(httpUrl.href);
      const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
      const timeout = Math.min(
        request.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS,
        HANDSHAKE_TIMEOUT_MS,
      );
      const socket = new Socket(request.url, {
        headers: request.headers,
        handshakeTimeout: timeout,
        maxPayload: MAX_PAYLOAD_BYTES,
        followRedirects: false,
        rejectUnauthorized: true,
        ...(agent ? { agent } : {}),
      });
      let responseHeaders = new Headers();
      socket.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const deadline = setTimeout(
            () =>
              finish(
                new ResponsesWebSocketConnectError(
                  "Responses WebSocket handshake timed out",
                  true,
                ),
              ),
            timeout,
          );
          deadline.unref?.();
          const onUpgrade = (response: import("node:http").IncomingMessage) => {
            responseHeaders = headersFromIncoming(response.headers);
          };
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            socket.off("upgrade", onUpgrade);
            socket.off("close", onHandshakeClose);
            request.signal?.removeEventListener("abort", onAbort);
            socket.off("open", onOpen);
            socket.off("error", onError);
            socket.off("unexpected-response", onUnexpectedResponse);
            if (error) reject(error);
            else resolve();
          };
          const onHandshakeClose = () =>
            finish(
              new ResponsesWebSocketConnectError(
                "Responses WebSocket closed during handshake",
                true,
              ),
            );
          const onOpen = () => finish();
          const onError = (error: Error) => finish(error);
          const onAbort = () => {
            socket.terminate();
            finish(abortError(request.signal));
          };
          const onUnexpectedResponse = (
            _ws: WebSocket,
            response: import("node:http").IncomingMessage,
          ) => {
            const status = response.statusCode;
            const headers = headersFromIncoming(response.headers);
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= 64 * 1024) chunks.push(chunk);
              else {
                response.destroy();
                finish(
                  new ResponsesWebSocketConnectError(
                    "Responses WebSocket handshake body exceeded limit",
                    false,
                    status,
                    headers,
                  ),
                );
              }
            });
            response.on("error", () =>
              finish(
                new ResponsesWebSocketConnectError(
                  "Responses WebSocket handshake body interrupted",
                  false,
                  status,
                  headers,
                ),
              ),
            );
            response.on("aborted", () =>
              finish(
                new ResponsesWebSocketConnectError(
                  "Responses WebSocket handshake body interrupted",
                  false,
                  status,
                  headers,
                ),
              ),
            );
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let body: unknown = text;
              try {
                body = text ? JSON.parse(text) : undefined;
              } catch {
                /* Keep bounded text body. */
              }
              const fallbackAllowed = status === 426 || status === undefined;
              finish(
                new ResponsesWebSocketConnectError(
                  `Responses WebSocket handshake failed${status ? ` with status ${status}` : ""}`,
                  fallbackAllowed,
                  status,
                  headers,
                  body,
                ),
              );
            });
          };
          socket.once("upgrade", onUpgrade);
          socket.once("close", onHandshakeClose);
          socket.once("open", onOpen);
          socket.once("error", onError);
          socket.once("unexpected-response", onUnexpectedResponse);
          request.signal?.addEventListener("abort", onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
        });
      } catch (error) {
        socket.terminate();
        if (error instanceof ResponsesWebSocketConnectError) throw error;
        if (request.signal?.aborted) throw abortError(request.signal);
        const tlsFailure = Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(
            String((error as { code: unknown }).code),
          ),
        );
        throw new ResponsesWebSocketConnectError(
          error instanceof Error
            ? error.message
            : "Responses WebSocket connection failed",
          !tlsFailure,
        );
      }
      request.onTransportActivity?.({ kind: "websocket", at: startedAt });
      return new NodeResponsesWebSocketConnection(socket, responseHeaders);
    },
  };
}

export const nodeResponsesWebSocketConnector =
  createResponsesWebSocketConnector();
