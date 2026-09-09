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
import type { CodexRequestBody } from "./translation.js";
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
  /** Mutable parser state for this stream attempt. Do not reuse across retries. */
  parserState?: CodexStreamParserState;
  parserOptions?: CodexStreamParserOptions;
  maxRetries?: number;
  retryDelay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  runRequest?: <T>(operation: () => T) => T;
}): AsyncGenerator<CoreModelStreamEvent> {
  let stream: unknown;
  try {
    if (typeof args.body.model !== "string") {
      throw new Error("Codex Responses request model is required");
    }
    const runRequest =
      args.runRequest ?? (<T>(operation: () => T): T => operation());
    const maxRetries = args.maxRetries ?? 0;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new Error(
        "Codex Responses maxRetries must be a non-negative integer",
      );
    }
    const routing = args.authMethod === "oauth" ? args.routing : undefined;
    const binding = routing?.turnState.bind(
      routing.sessionId,
      routing.authIdentity,
      args.body.model,
    );
    let disabled = binding?.disabled ?? false;
    let retryAttempt = 0;
    for (;;) {
      const headers = {
        ...getCodexResponsesRequestHeaders(args.body.model, args.authMethod),
        ...(routing ? { session_id: routing.sessionId } : {}),
        ...(!disabled && binding?.value
          ? { [CODEX_TURN_STATE_HEADER]: binding.value }
          : {}),
      };
      const body = disabled ? { ...args.body } : args.body;
      if (disabled) delete body.prompt_cache_key;
      const attempt = { model: args.body.model };
      args.beforeModelDispatch?.(attempt);
      try {
        args.onProviderRequestAttempt?.(attempt);
        const pending = runRequest(() =>
          args.client.responses.create(body, {
            signal: args.signal,
            maxRetries: 0,
            ...(Object.keys(headers).length ? { headers } : {}),
          }),
        );
        // The SDK exposes response headers on its promise, not on the stream.
        if (
          binding &&
          pending &&
          typeof (pending as { withResponse?: unknown }).withResponse ===
            "function"
        ) {
          const response = await (
            pending as {
              withResponse(): Promise<{
                data: unknown;
                response: { headers: Headers };
              }>;
            }
          ).withResponse();
          captureCodexTurnState(
            binding,
            response.response.headers.get(CODEX_TURN_STATE_HEADER),
          );
          stream = response.data;
        } else {
          stream = await pending;
        }
        break;
      } catch (error) {
        if (
          args.authMethod === "oauth" &&
          !disabled &&
          (body.prompt_cache_key || binding?.value) &&
          !args.signal?.aborted &&
          isCodexRoutingRejection(error)
        ) {
          disabled = true;
          if (binding) {
            binding.disabled = true;
            binding.value = undefined;
          }
          continue;
        }
        if (
          !args.signal?.aborted &&
          retryAttempt < maxRetries &&
          isRetryableResponsesError(error)
        ) {
          const retryAfterMs = retryDelayMs(error, retryAttempt);
          retryAttempt += 1;
          await (args.retryDelay ?? defaultRetryDelay)(
            retryAfterMs,
            args.signal,
          );
          continue;
        }
        throw error;
      }
    }
  } catch (err) {
    if (isCodexAuthError(err)) throw new CodexResponsesAuthError(err);
    throw err;
  }

  const iterator = parseCodexResponseStreamEvents(
    observeProviderEvents(
      stream as AsyncIterable<Record<string, unknown>>,
      args.onTransportActivity,
    ),
    args.parserState,
    args.parserOptions,
  )[Symbol.asyncIterator]();

  try {
    while (true) {
      const result = await nextCodexStreamEvent(iterator, args.signal);
      if (result.done) break;
      yield result.value;
    }
  } catch (err) {
    if (isCodexAuthError(err)) throw new CodexResponsesAuthError(err);
    throw err;
  } finally {
    try {
      void iterator.return?.(undefined).catch(() => undefined);
    } catch {
      // Best-effort cleanup only; preserve the original stream outcome.
    }
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

function isRetryableResponsesError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}

function retryDelayMs(error: unknown, attempt: number): number {
  const maxDelayMs = 5_000;
  if (error && typeof error === "object") {
    const headers = (error as { headers?: unknown }).headers;
    if (headers instanceof Headers) {
      const milliseconds = Number(headers.get("retry-after-ms"));
      if (Number.isFinite(milliseconds)) {
        return Math.min(maxDelayMs, Math.max(0, milliseconds));
      }
      const seconds = Number(headers.get("retry-after"));
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
