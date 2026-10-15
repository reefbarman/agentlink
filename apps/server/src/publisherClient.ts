import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import {
  SNAPSHOT_BRANCH_HEADER,
  type ConnectionStatus,
  type PublishRequest,
  type PublishResult,
  type ReachableRepositories,
  type SnapshotRequest,
} from "./publisher.js";

/** Largest repository snapshot the server accepts. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The assistant server's side of the publisher: plain HTTP on a private
 * network, authenticated with the shared token. The server never sees a
 * GitHub token; it only asks for sign-ins, statuses and publishes.
 */

export class PublisherRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PublisherRequestError";
  }
}

export interface PublisherClient {
  health(): Promise<{
    readonly protocol: number;
    readonly deviceFlow: boolean;
  }>;
  startDeviceFlow(connectionId: string): Promise<ConnectionStatus>;
  status(connectionId: string): Promise<ConnectionStatus>;
  importToken(connectionId: string, token: string): Promise<ConnectionStatus>;
  remove(connectionId: string): Promise<boolean>;
  /** The repositories a connection can reach (names, never a token). */
  repositories(connectionId: string): Promise<ReachableRepositories>;
  publish(request: PublishRequest): Promise<PublishResult>;
  /**
   * Write a git bundle of the repository's base branch to `destination`,
   * fetched by the publisher with the connection's token.
   */
  snapshot(
    request: SnapshotRequest,
    destination: string,
  ): Promise<{ readonly branch: string }>;
}

export function createPublisherClient(options: {
  readonly host: string;
  readonly port: number;
  /** Reads the shared token (rereads it after a rotation). */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): PublisherClient {
  const fetchImpl = options.fetch ?? fetch;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const base = `http://${host}:${options.port}`;
  // Publishing pushes a whole branch: give it time.
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1_000;

  const send = async (
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${await options.token()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PublisherRequestError(
        503,
        "publisher_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const failed = async (response: Response) => {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const failure = (parsed ?? {}) as { error?: unknown; detail?: unknown };
    return new PublisherRequestError(
      response.status,
      typeof failure.error === "string" ? failure.error : "publisher_error",
      typeof failure.detail === "string" ? failure.detail : undefined,
    );
  };

  const call = async <T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await send(method, pathname, body);
    if (!response.ok) throw await failed(response);
    try {
      return (await response.json()) as T;
    } catch {
      return undefined as T;
    }
  };

  const connection = (id: string) =>
    `/v1/connections/${encodeURIComponent(id)}`;

  return {
    health: () => call("GET", "/v1/health"),
    startDeviceFlow: (id) => call("POST", `${connection(id)}/device`),
    status: (id) => call("GET", connection(id)),
    importToken: (id, token) =>
      call("PUT", `${connection(id)}/token`, { token }),
    remove: async (id) =>
      (await call<{ removed: boolean }>("DELETE", connection(id))).removed,
    repositories: (id) => call("GET", `${connection(id)}/repositories`),
    publish: (request) => call("POST", "/v1/publish", request),
    async snapshot(request, destination) {
      const response = await send("POST", "/v1/snapshot", request);
      if (!response.ok) throw await failed(response);
      const branch = response.headers.get(SNAPSHOT_BRANCH_HEADER);
      if (!branch || !response.body) {
        throw new PublisherRequestError(502, "snapshot_invalid");
      }
      let received = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          done(
            received > MAX_SNAPSHOT_BYTES
              ? new PublisherRequestError(413, "repository_too_large")
              : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
          limit,
          createWriteStream(destination, { mode: 0o644 }),
        );
      } catch (error) {
        if (error instanceof PublisherRequestError) throw error;
        throw new PublisherRequestError(
          502,
          "snapshot_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return { branch };
    },
  };
}
