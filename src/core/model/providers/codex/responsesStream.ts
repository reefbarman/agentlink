import type { CoreModelStreamEvent } from "../../../modelRuntime.js";
import {
  parseCodexResponseStreamEvents,
  type CodexStreamParserOptions,
  type CodexStreamParserState,
} from "./streamParser.js";
import type { CodexRequestBody } from "./translation.js";

export interface CodexResponsesClient {
  responses: {
    create: (
      body: CodexRequestBody,
      options?: { signal?: AbortSignal },
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
  signal?: AbortSignal;
  /** Mutable parser state for this stream attempt. Do not reuse across retries. */
  parserState?: CodexStreamParserState;
  parserOptions?: CodexStreamParserOptions;
}): AsyncGenerator<CoreModelStreamEvent> {
  let stream: unknown;
  try {
    stream = await args.client.responses.create(args.body, {
      signal: args.signal,
    });
  } catch (err) {
    if (isCodexAuthError(err)) throw new CodexResponsesAuthError(err);
    throw err;
  }

  const iterator = parseCodexResponseStreamEvents(
    stream as AsyncIterable<Record<string, unknown>>,
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

function isCodexAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
