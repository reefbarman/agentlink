import type {
  ConnectionStatus,
  PublishRequest,
  PublishResult,
} from "./publisher.js";

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
  publish(request: PublishRequest): Promise<PublishResult>;
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

  const call = async <T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
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
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const failure = (parsed ?? {}) as { error?: unknown; detail?: unknown };
      throw new PublisherRequestError(
        response.status,
        typeof failure.error === "string" ? failure.error : "publisher_error",
        typeof failure.detail === "string" ? failure.detail : undefined,
      );
    }
    return parsed as T;
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
    publish: (request) => call("POST", "/v1/publish", request),
  };
}
