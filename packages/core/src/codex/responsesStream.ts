import type {
  CoreModelProviderRequestAttempt,
  CoreModelStreamEvent,
  CoreModelTransportActivity,
} from "../modelRuntime.js";
import {
  getCodexResponsesRequestHeaders,
  type CodexAuthMethod,
} from "./models.js";
import {
  parseCodexResponseStreamEvents,
  type CodexStreamParserOptions,
  type CodexStreamParserState,
} from "./streamParser.js";
import type { CodexResponsesRequestOptions } from "./openaiClient.js";
import {
  dispatchResponsesHttp,
  ResponsesWebSocketRejectionError,
  ResponsesTransportInterruptedError,
  type ResponsesDispatchEvidence,
  type ResponsesWebSocketRequestContext,
} from "./responsesTransport.js";
import {
  ResponsesTransportSession,
  isSafeResponsesConnectFallback,
} from "./ResponsesTransportSession.js";
import type { CodexRequestBody } from "./translation.js";
import { isCodexUsageLimitError, toCodexRequestError } from "./errors.js";
import {
  ResponsesConversationState,
  decideResponsesRecovery,
  isResponsesFatalRecoveryError,
  isResponsesInterruption,
  responsesPhaseFromEvidence,
  responsesRetryReason,
} from "./responsesRecovery.js";
import {
  CODEX_TURN_STATE_HEADER,
  captureCodexTurnState,
  isCodexRoutingRejection,
  type CodexTurnRouting,
} from "./turnRouting.js";

export interface CodexResponsesClient {
  responses: {
    create: (
      body: CodexRequestBody,
      options?: CodexResponsesRequestOptions,
    ) => unknown;
  };
}

export class CodexResponsesAuthError extends Error {
  constructor(readonly cause: unknown) {
    super("Codex Responses authentication failed");
    this.name = "CodexResponsesAuthError";
  }
}

export class CodexResponsesStreamAbortedError extends Error {
  constructor() {
    super("Codex Responses stream aborted");
    this.name = "CodexResponsesStreamAbortedError";
  }
}

export async function* executeCodexResponsesStream(args: {
  client: CodexResponsesClient;
  body: CodexRequestBody;
  authMethod?: CodexAuthMethod;
  routing?: CodexTurnRouting;
  signal?: AbortSignal;
  beforeModelDispatch?: (attempt: CoreModelProviderRequestAttempt) => void;
  onProviderRequestAttempt?: (attempt: CoreModelProviderRequestAttempt) => void;
  onTransportActivity?: (activity: CoreModelTransportActivity) => void;
  parserState?: CodexStreamParserState;
  parserOptions?: CodexStreamParserOptions;
  maxRetries?: number;
  retryDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  runRequest?: <T>(operation: () => T) => T;
  webSocket?: ResponsesWebSocketRequestContext;
  dispatchEvidence?: ResponsesDispatchEvidence;
  recoveryMode?: "internal" | "external";
  conversationState?: ResponsesConversationState;
}): AsyncGenerator<CoreModelStreamEvent> {
  const maxRetries = args.maxRetries ?? 11;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      "Codex Responses maxRetries must be a non-negative integer",
    );
  }
  if (typeof args.body.model !== "string")
    throw new Error("Codex Responses request model is required");
  const evidence = args.dispatchEvidence ?? {
    transport: "http" as const,
    phase: "not_sent" as const,
  };
  const ws = args.webSocket;
  const session = ws?.session ?? new ResponsesTransportSession();
  const conversation =
    args.conversationState ??
    ws?.conversationState ??
    new ResponsesConversationState();
  session.assertAvailable();
  session.configure(ws?.enabled ?? false);
  ws?.policy?.observe(ws.enabled);
  if (ws) conversation.observe(ws.identity, ws.enabled);
  if (conversation.httpOnly) session.useHttp();
  const ephemeral = !ws?.session;
  const routing = args.authMethod === "oauth" ? args.routing : undefined;
  const binding = routing?.turnState.bind(
    routing.sessionId,
    routing.authIdentity,
    args.body.model,
  );
  let disabled = binding?.disabled ?? false;
  let continuationRetried = false;
  let retriesUsed = 0;
  let retriesInPhase = 0;
  let dispatches = 0;
  let outputBytes = 0;
  let socketAttempted = Boolean(
    ws?.enabled && (conversation.httpOnly || session.httpOnly),
  );
  const runRequest =
    args.runRequest ?? (<T>(operation: () => T): T => operation());
  const beforeDispatch = (attempt: CoreModelProviderRequestAttempt) => {
    if (dispatches >= Math.min(12, maxRetries + 1)) {
      throw Object.assign(new Error("Responses model attempt limit reached"), {
        recoveryHandled: true,
        retryable: false,
      });
    }
    args.beforeModelDispatch?.(attempt);
    dispatches += 1;
  };
  try {
    for (;;) {
      if (args.signal?.aborted) throw new CodexResponsesStreamAbortedError();
      const hostedWebSearch =
        args.body.tools?.some((tool) => tool.type === "web_search") === true;
      const headers = {
        ...(hostedWebSearch
          ? undefined
          : getCodexResponsesRequestHeaders(args.body.model, args.authMethod)),
        ...(routing ? { session_id: routing.sessionId } : {}),
        ...(!disabled && binding?.value
          ? { [CODEX_TURN_STATE_HEADER]: binding.value }
          : {}),
      };
      const body = disabled ? { ...args.body } : args.body;
      if (disabled) delete body.prompt_cache_key;
      let socketUsed = false;
      let socketCompleted = false;
      let iterator: AsyncIterator<CoreModelStreamEvent> | undefined;
      let wireBody: Record<string, unknown> | undefined;
      let stream!: AsyncIterable<Record<string, unknown>>;
      const parserState = args.parserState ?? { outputStarted: false };
      parserState.outputStarted = false;
      try {
        const eligible =
          ws?.enabled &&
          !conversation.httpOnly &&
          !session.httpOnly &&
          (!body.previous_response_id || ws.fullBody);
        if (eligible && ws && ws.policy?.suppressed(ws.identity))
          session.useHttp();
        if (eligible && ws && !session.httpOnly) {
          evidence.transport = "websocket";
          evidence.phase = "not_sent";
          evidence.verifiedRejection = undefined;
          evidence.terminalFailure = undefined;
          socketAttempted = true;
          try {
            const startedAt = Date.now();
            const handshakeHeaders = { ...ws.headers, ...headers };
            if (disabled) delete handshakeHeaders[CODEX_TURN_STATE_HEADER];
            const { connection, reused } = await session.connect(
              ws.connector,
              {
                url: ws.url,
                headers: handshakeHeaders,
                signal: args.signal,
                handshakeTimeoutMs: 15_000,
                onTransportActivity: args.onTransportActivity,
              },
              JSON.stringify([
                ws.identity,
                args.body.model,
                disabled,
                hostedWebSearch,
              ]),
            );
            if (binding)
              captureCodexTurnState(
                binding,
                connection.headers.get(CODEX_TURN_STATE_HEADER),
              );
            wireBody = { ...(ws.fullBody ?? body) };
            delete wireBody.stream;
            delete wireBody.previous_response_id;
            if (disabled) delete wireBody.prompt_cache_key;
            if (args.authMethod === "oauth" && binding?.value && !disabled) {
              wireBody.client_metadata = {
                ...(wireBody.client_metadata as
                  | Record<string, unknown>
                  | undefined),
                [CODEX_TURN_STATE_HEADER]: binding.value,
              };
            }
            wireBody.type = "response.create";
            const prepared = ws.incremental
              ? session.prepareBody(wireBody)
              : { body: wireBody, incremental: false };
            const attempt = {
              model: args.body.model,
              dispatchEvidence: evidence,
            };
            beforeDispatch(attempt);
            args.onProviderRequestAttempt?.(attempt);
            socketUsed = true;
            stream = connection.dispatch({
              body: prepared.body,
              signal: args.signal,
              evidence,
              onTransportActivity: args.onTransportActivity,
            });
            ws.onDiagnostics?.({
              transport: "websocket",
              policy: true,
              reused,
              incremental: prepared.incremental,
              handshakeMs: Date.now() - startedAt,
            });
          } catch (error) {
            session.release(false);
            if (
              args.signal?.aborted ||
              evidence.phase !== "not_sent" ||
              !isSafeResponsesConnectFallback(error)
            )
              throw error;
            ws.policy?.failure(ws.identity);
            session.useHttp();
            yield {
              type: "transport_fallback",
              message:
                "WebSocket connection failed before the request was sent. Continuing over HTTP.",
            };
            ws.onFallback?.(
              "WebSocket connection failed before the request was sent. Continuing over HTTP.",
            );
            ws.onDiagnostics?.({
              transport: "http",
              policy: true,
              reused: false,
              fallbackReason: "connect_failed",
            });
          }
        }
        if (!socketUsed) {
          const httpBody =
            socketAttempted && ws?.fullBody
              ? { ...ws.fullBody, stream: true as const }
              : body;
          if (disabled) delete httpBody.prompt_cache_key;
          const response = await dispatchResponsesHttp({
            client: args.client,
            body: httpBody,
            headers,
            captureHeaders: Boolean(binding),
            signal: args.signal,
            evidence,
            beforeModelDispatch: beforeDispatch,
            onProviderRequestAttempt: args.onProviderRequestAttempt,
            runRequest,
          });
          if (binding && response.headers)
            captureCodexTurnState(
              binding,
              response.headers.get(CODEX_TURN_STATE_HEADER),
            );
          stream = response.events as AsyncIterable<Record<string, unknown>>;
        }
        const tracked = (async function* () {
          for await (const event of stream) {
            if (
              event.type === "response.completed" ||
              event.type === "response.done" ||
              event.type === "response.incomplete" ||
              event.type === "response.failed"
            )
              socketCompleted = true;
            yield event;
          }
          if (socketUsed && !socketCompleted)
            throw new ResponsesTransportInterruptedError();
        })();
        const maxOutputBytes = args.parserOptions?.maxOutputBytes;
        const parsed = parseCodexResponseStreamEvents(
          observeProviderEvents(tracked, args.onTransportActivity),
          parserState,
          {
            ...args.parserOptions,
            maxOutputBytes:
              maxOutputBytes === undefined
                ? undefined
                : Math.max(0, maxOutputBytes - outputBytes),
            onCompletedOutput: (output, responseId) => {
              args.parserOptions?.onCompletedOutput?.(output, responseId);
              if (socketUsed && ws?.incremental && wireBody) {
                session.captureCompletion(
                  wireBody,
                  { type: "response.completed", response: { id: responseId } },
                  output,
                );
              }
            },
          },
        );
        iterator = parsed[Symbol.asyncIterator]();
        let openThinkingId: string | undefined;
        try {
          for (;;) {
            const next = await nextCodexStreamEvent(iterator, args.signal);
            if (next.done) break;
            const event = next.value;
            if (event.type === "thinking_start")
              openThinkingId = event.thinkingId;
            if (event.type === "thinking_end") openThinkingId = undefined;
            if (event.type === "text_delta" || event.type === "thinking_delta")
              outputBytes += Buffer.byteLength(event.text, "utf8");
            if (event.type === "tool_input_delta")
              outputBytes += Buffer.byteLength(event.partialJson, "utf8");
            yield event;
          }
        } catch (error) {
          if (openThinkingId)
            yield { type: "thinking_end", thinkingId: openThinkingId };
          throw error;
        }
        if (socketUsed && ws) ws.policy?.success(ws.identity);
        return;
      } catch (error) {
        if (args.signal?.aborted) throw new CodexResponsesStreamAbortedError();
        if (
          error &&
          typeof error === "object" &&
          (error as { recoveryHandled?: unknown }).recoveryHandled === true
        )
          throw error;
        if (
          args.authMethod === "oauth" &&
          isCodexUsageLimitError(toCodexRequestError(error))
        )
          throw error;
        const continuationRejected =
          error instanceof ResponsesWebSocketRejectionError &&
          error.code === "previous_response_not_found" &&
          error.verifiedRejection &&
          !continuationRetried;
        const routingRejected =
          args.authMethod === "oauth" &&
          !disabled &&
          (body.prompt_cache_key || binding?.value) &&
          isCodexRoutingRejection(error) &&
          !parserState.outputStarted;
        if (
          (continuationRejected || routingRejected) &&
          retriesUsed < maxRetries
        ) {
          if (continuationRejected) continuationRetried = true;
          if (routingRejected) {
            disabled = true;
            if (binding) {
              binding.disabled = true;
              binding.value = undefined;
            }
          }
          retriesUsed += 1;
          session.invalidate();
          continue;
        }
        if (
          args.recoveryMode === "external" ||
          isResponsesFatalRecoveryError(error) ||
          !isResponsesInterruption(error)
        ) {
          if (isCodexAuthError(error)) throw new CodexResponsesAuthError(error);
          throw error;
        }
        const phase = responsesPhaseFromEvidence(evidence);
        const decision = decideResponsesRecovery({
          phase,
          retriesInPhase,
          retriesUsed,
          maxRetries,
          dispatches,
          maxDispatches: Math.min(12, maxRetries + 1),
          canRedispatch: true,
          retryable: true,
          conversationState: conversation,
        });
        if (decision.action === "exhausted")
          throw Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            { recoveryHandled: true },
          );
        retriesUsed += 1;
        retriesInPhase =
          decision.action === "fallback" ? 0 : retriesInPhase + 1;
        if (decision.action === "fallback") session.useHttp();
        else session.release(false);
        const delayMs = retryDelayMs(error, retriesInPhase - 1);
        yield {
          type: "response_retry",
          attempt: retriesUsed,
          phase: decision.phase,
          delayMs,
          reason: responsesRetryReason(error),
        };
        await (args.retryDelay ?? defaultRetryDelay)(delayMs, args.signal);
      } finally {
        if (socketUsed) session.release(socketCompleted);
        try {
          void iterator?.return?.().catch(() => undefined);
        } catch {
          /* Best-effort iterator cleanup. */
        }
      }
    }
  } finally {
    if (ephemeral) session.dispose();
  }
}

async function* observeProviderEvents(
  events: AsyncIterable<Record<string, unknown>>,
  onTransportActivity?: (activity: CoreModelTransportActivity) => void,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of events) {
    onTransportActivity?.({ kind: "provider_event", at: Date.now() });
    yield event;
  }
}

function nextCodexStreamEvent(
  iterator: AsyncIterator<CoreModelStreamEvent>,
  signal?: AbortSignal,
): Promise<IteratorResult<CoreModelStreamEvent>> {
  if (!signal) return iterator.next();
  if (signal.aborted) throw new CodexResponsesStreamAbortedError();

  let cleanup: () => void = () => undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new CodexResponsesStreamAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });

  return Promise.race([iterator.next(), abortPromise]).finally(cleanup);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const maxDelayMs = 5_000;
  if (error && typeof error === "object") {
    const headers = (error as { headers?: unknown }).headers;
    if (headers instanceof Headers) {
      const milliseconds = Number(headers.get("retry-after-ms") ?? NaN);
      if (Number.isFinite(milliseconds)) {
        return Math.min(maxDelayMs, Math.max(0, milliseconds));
      }
      const seconds = Number(headers.get("retry-after") ?? NaN);
      if (Number.isFinite(seconds)) {
        return Math.min(maxDelayMs, Math.max(0, seconds * 1000));
      }
    }
  }
  return Math.min(maxDelayMs, 250 * 2 ** attempt);
}

function defaultRetryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new CodexResponsesStreamAbortedError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CodexResponsesStreamAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isCodexAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
