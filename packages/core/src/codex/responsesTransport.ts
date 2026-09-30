import type {
  CoreModelProviderRequestAttempt,
  CoreModelTransportActivity,
} from "../modelRuntime.js";
import type {
  ResponsesTransportPolicy,
  ResponsesTransportSession,
} from "./ResponsesTransportSession.js";

import type { CodexRequestBody } from "./translation.js";
import type { CodexResponsesRequestOptions } from "./openaiClient.js";

export type ResponsesDispatchPhase =
  | "not_sent"
  | "sent_unacknowledged"
  | "response_started"
  | "terminal";

/** Runtime-only evidence. Never serialize credential or connection state. */
export interface ResponsesDispatchEvidence {
  transport: "http" | "websocket";
  phase: ResponsesDispatchPhase;
  verifiedRejection?: boolean;
  terminalFailure?: boolean;
}

export function canRedispatchResponses(
  evidence: ResponsesDispatchEvidence,
): boolean {
  return (
    evidence.transport === "http" ||
    evidence.phase === "not_sent" ||
    evidence.verifiedRejection === true ||
    (evidence.phase === "terminal" && evidence.terminalFailure === true)
  );
}

export class ResponsesTransportInterruptedError extends Error {
  readonly retryable = true;
  readonly code = "responses_stream_interrupted";

  constructor(readonly cause?: unknown) {
    super("Codex Responses stream was interrupted");
    this.name = "ResponsesTransportInterruptedError";
  }
}

export class ResponsesNonReplayableError extends Error {
  readonly nonReplayable = true;
  readonly shouldRetry = false;
  readonly retryable = false;
  readonly code = "responses_websocket_unknown_outcome";

  constructor(readonly cause?: unknown) {
    super(
      "The WebSocket response was interrupted after the request was sent. Its outcome is unknown and it was not automatically retried. Send a new message to continue.",
    );
    this.name = "ResponsesNonReplayableError";
  }
}

export function isNonReplayableResponsesError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { nonReplayable?: unknown }).nonReplayable === true,
  );
}

export class ResponsesWebSocketConnectError extends Error {
  constructor(
    message: string,
    readonly fallbackAllowed: boolean,
    readonly status?: number,
    readonly headers?: Headers,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ResponsesWebSocketConnectError";
  }
}

export class ResponsesWebSocketRejectionError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
    readonly headers: Headers,
    readonly body: unknown,
    readonly verifiedRejection: boolean,
  ) {
    super(message);
    this.name = "ResponsesWebSocketRejectionError";
  }
}

export interface ResponsesWebSocketConnectRequest {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  handshakeTimeoutMs: number;
  onTransportActivity?: (activity: CoreModelTransportActivity) => void;
}

export interface ResponsesWebSocketDispatchRequest {
  /** Flattened response.create payload, without HTTP-only stream. */
  body: Record<string, unknown>;
  signal?: AbortSignal;
  evidence: ResponsesDispatchEvidence;
  onTransportActivity?: (activity: CoreModelTransportActivity) => void;
}

export interface ResponsesWebSocketConnection {
  readonly headers: Headers;
  readonly isOpen: boolean;
  dispatch(
    request: ResponsesWebSocketDispatchRequest,
  ): AsyncIterable<Record<string, unknown>>;
  /** Idempotent, bounded cleanup, including pending connection/iterator work. */
  close(): void;
}

export interface ResponsesWebSocketConnector {
  connect(
    request: ResponsesWebSocketConnectRequest,
  ): Promise<ResponsesWebSocketConnection>;
}

export interface ResponsesTransportDiagnostics {
  transport: "http" | "websocket";
  policy: boolean;
  reused: boolean;
  incremental?: boolean;
  fallbackReason?: "connect_failed" | "temporarily_suppressed";
  handshakeMs?: number;
  firstEventMs?: number;
  terminalOutcome?: "completed" | "incomplete" | "failed" | "interrupted";
}

export interface ResponsesWebSocketRequestContext {
  connector: ResponsesWebSocketConnector;
  enabled: boolean;
  url: string;
  headers: Record<string, string>;
  /** Private, opaque connection identity. Never log it. */
  identity: string;
  session?: ResponsesTransportSession;
  conversationState?: import("./responsesRecovery.js").ResponsesConversationState;
  policy?: ResponsesTransportPolicy;
  /** Explicit second-stage optimisation, disabled until transport validation. */
  incremental?: boolean;
  /** Full replay independently assembled before stateful HTTP translation. */
  fullBody?: CodexRequestBody;
  onDiagnostics?: (diagnostics: ResponsesTransportDiagnostics) => void;
  onFallback?: (message: string) => void;
}

export interface ResponsesHttpClient {
  responses: {
    create(
      body: CodexRequestBody,
      options?: CodexResponsesRequestOptions,
    ): unknown;
  };
}

export interface ResponsesHttpDispatchRequest {
  client: ResponsesHttpClient;
  body: CodexRequestBody;
  headers: Record<string, string>;
  signal?: AbortSignal;
  evidence: ResponsesDispatchEvidence;
  captureHeaders?: boolean;
  beforeModelDispatch?: (attempt: CoreModelProviderRequestAttempt) => void;
  onProviderRequestAttempt?: (attempt: CoreModelProviderRequestAttempt) => void;
  runRequest?: <T>(operation: () => T) => T;
  /** Mark successful HTTP model completion using canonical parsed output. */
  captureCompletion?: (
    body: Record<string, unknown>,
    event: Record<string, unknown>,
    output?: Array<Record<string, unknown>>,
  ) => void;
}

/** Keep SDK HTTP promise/header behaviour intact, including custom fetch. */
export async function dispatchResponsesHttp(
  request: ResponsesHttpDispatchRequest,
): Promise<{
  events: AsyncIterable<Record<string, unknown>>;
  headers?: Headers;
}> {
  if (typeof request.body.model !== "string") {
    throw new Error("Codex Responses request model is required");
  }
  const attempt = {
    model: request.body.model,
    dispatchEvidence: request.evidence,
  };
  request.evidence.transport = "http";
  request.evidence.phase = "not_sent";
  request.evidence.verifiedRejection = undefined;
  request.beforeModelDispatch?.(attempt);
  request.onProviderRequestAttempt?.(attempt);
  request.evidence.phase = "sent_unacknowledged";
  const operation = () =>
    request.client.responses.create(request.body, {
      signal: request.signal,
      maxRetries: 0,
      ...(Object.keys(request.headers).length
        ? { headers: request.headers }
        : {}),
    });
  const pending = request.runRequest
    ? request.runRequest(operation)
    : operation();
  if (
    request.captureHeaders &&
    pending &&
    typeof (pending as { withResponse?: unknown }).withResponse === "function"
  ) {
    const response = await (
      pending as {
        withResponse(): Promise<{
          data: AsyncIterable<Record<string, unknown>>;
          response: { headers: Headers };
        }>;
      }
    ).withResponse();
    return { events: response.data, headers: response.response.headers };
  }
  return { events: (await pending) as AsyncIterable<Record<string, unknown>> };
}
