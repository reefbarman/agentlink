import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { tokensMatch } from "./commandWorkerProtocol.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import { singleHeader } from "./requestGuard.js";

/**
 * Shared HTTP plumbing for the session runner protocols: the control plane
 * calling a runner (its sessions), and a runner calling the control plane
 * (models and host tools). Plain HTTP on a private container network, every
 * request carrying a bearer token. A call is `POST <path>` with a JSON body;
 * the reply is JSON (`{ value }`) or, for streams, newline-delimited JSON.
 * Failures are `{ error }` with the error's name, message and code, so the
 * caller can rethrow an error that the existing code paths recognize.
 */

/** Model requests carry whole conversations. */
export const MAX_RUNNER_BODY_BYTES = 32 * 1024 * 1024;
const STREAM_KEEPALIVE_MS = 15_000;

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

/** The error's name, message and own primitive properties (code, status…). */
export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      fields[key] = value;
    }
  }
  return { ...fields, name: error.name, message: error.message };
}

/** An `Error` with the same name, message and properties. */
export function deserializeError(value: unknown): Error {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const error = new Error(
    typeof record.message === "string" ? record.message : "runner_error",
  );
  for (const [key, field] of Object.entries(record)) {
    if (key === "message" || key === "stack") continue;
    (error as unknown as Record<string, unknown>)[key] = field;
  }
  if (typeof record.name === "string") error.name = record.name;
  return error;
}

export type RunnerRouteHandler = (
  body: Record<string, unknown>,
  context: {
    readonly signal: AbortSignal;
    readonly request: IncomingMessage;
    /** Switch the reply to a line stream; each call writes one line. */
    readonly stream: () => (line: unknown) => void;
  },
) => Promise<unknown>;

export interface RunnerHttpServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Serve `routes` (`POST /path`), plus `GET /health`, to callers presenting a
 * token `authorize` accepts. `authorize` returns what the handler needs to
 * know about the caller (or undefined to refuse).
 */
export async function startRunnerHttpServer<Caller>(options: {
  readonly host: string;
  readonly port: number;
  readonly authorize: (token: string) => Caller | undefined;
  readonly routes: (
    caller: Caller,
  ) => Readonly<Record<string, RunnerRouteHandler>>;
  readonly health?: (caller: Caller) => unknown;
  readonly log?: (line: string) => void;
}): Promise<RunnerHttpServer> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        const status = error instanceof HttpError ? error.status : 500;
        sendJson(response, status, { error: serializeError(error) });
      } else {
        // Mid-stream: report it as the last line.
        writeLine(response, { type: "error", error: serializeError(error) });
        response.end();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const header = singleHeader(request.headers.authorization) ?? "";
    const presented = /^Bearer (.+)$/u.exec(header)?.[1];
    const caller = presented ? options.authorize(presented) : undefined;
    if (caller === undefined) throw new HttpError(401, "unauthorized");
    const url = new URL(request.url ?? "/", "http://runner");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        ...(options.health?.(caller) as object | undefined),
      });
      return;
    }
    const handler = options.routes(caller)[url.pathname];
    if (request.method !== "POST" || !handler) {
      throw new HttpError(404, "not_found");
    }
    const controller = new AbortController();
    // The caller going away (or aborting) stops the work it asked for.
    response.once("close", () => {
      if (!response.writableFinished) controller.abort("caller_disconnected");
    });
    const body = await readJsonBody(
      request,
      MAX_RUNNER_BODY_BYTES,
      controller.signal,
    );
    let streaming = false;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const stream = () => {
      if (!streaming) {
        streaming = true;
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        // Keeps idle proxies and watchdogs from treating a long model call
        // or tool as a dead connection.
        keepalive = setInterval(
          () => writeLine(response, { type: "keepalive" }),
          STREAM_KEEPALIVE_MS,
        );
        keepalive.unref();
      }
      return (line: unknown) => writeLine(response, line);
    };
    try {
      const value = await handler(body, {
        signal: controller.signal,
        request,
        stream,
      });
      if (streaming) {
        response.end();
      } else {
        sendJson(response, 200, value === undefined ? {} : { value });
      }
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

function writeLine(response: ServerResponse, line: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`${JSON.stringify(line)}\n`);
}

export interface RunnerHttpClient {
  /** `POST path` and return `value`; a failure rethrows the remote error. */
  call<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** `POST path` and yield each line of the streamed reply. */
  stream(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>>;
  health(signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/** Thrown when the other side could not be reached at all. */
export class RunnerUnreachableError extends Error {
  readonly code = "runner_unreachable";
  constructor(cause: unknown) {
    super("runner_unreachable", { cause });
    this.name = "RunnerUnreachableError";
  }
}

export function createRunnerHttpClient(options: {
  readonly baseUrl: string | (() => string);
  readonly token: string | (() => string);
  readonly fetch?: typeof fetch;
}): RunnerHttpClient {
  const doFetch = options.fetch ?? fetch;
  const resolve = <T>(value: T | (() => T)) =>
    typeof value === "function" ? (value as () => T)() : value;
  const request = async (
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal },
  ) => {
    let response: Response;
    try {
      response = await doFetch(`${resolve(options.baseUrl)}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${resolve(options.token)}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new RunnerUnreachableError(error);
    }
    if (!response.ok) {
      const parsed = (await response.json().catch(() => undefined)) as
        | { error?: unknown }
        | undefined;
      throw deserializeError(
        parsed?.error ?? {
          name: "HttpError",
          message: `http_${response.status}`,
          code: `http_${response.status}`,
          status: response.status,
        },
      );
    }
    return response;
  };
  return {
    async call<T>(
      path: string,
      body: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      const response = await request(path, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      });
      const parsed = (await response.json()) as { value?: unknown };
      return parsed.value as T;
    },
    async *stream(path, body, signal) {
      const response = await request(path, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          for (;;) {
            const end = buffered.indexOf("\n");
            if (end < 0) break;
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            if (!line.trim()) continue;
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.type === "error") throw deserializeError(parsed.error);
            yield parsed;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
    async health(signal) {
      const response = await request("/health", {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      return (await response.json()) as Record<string, unknown>;
    },
  };
}

/** Constant-time check of a presented token against the expected one. */
export function sameToken(expected: string, presented: string): boolean {
  return tokensMatch(expected, presented);
}
