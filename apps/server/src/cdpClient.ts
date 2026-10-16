import { promises as dns } from "node:dns";
import net from "node:net";

/**
 * A minimal Chrome DevTools Protocol client for the research browser:
 * commands with replies, events, flat sessions (`sessionId`), and nothing
 * else. Chromium checks the `Host` header of DevTools requests and only
 * accepts an IP address or localhost, so the container's name is resolved
 * first and the connection made by address.
 */

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

export interface CdpConnection {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

/** What `connectCdp` needs from a WebSocket (the global one in Node 22). */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export class CdpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

const COMMAND_TIMEOUT_MS = 30_000;

/** Wrap an open socket. */
export function cdpConnection(
  socket: CdpSocket,
  options: { readonly timeoutMs?: number } = {},
): CdpConnection {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<(event: CdpEvent) => void>();

  const fail = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  socket.addEventListener("message", (event) => {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(String(event.data)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new CdpError("cdp_command_failed", message.error.message ?? "failed"),
        );
      } else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const cdpEvent: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of listeners) {
        try {
          listener(cdpEvent);
        } catch {
          // A listener's failure is its own.
        }
      }
    }
  });
  const onClose = () => {
    closed = true;
    fail(new CdpError("cdp_closed", "The browser went away"));
  };
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onClose);

  return {
    get closed() {
      return closed;
    },
    send(method, params = {}, sessionId) {
      if (closed) {
        return Promise.reject(
          new CdpError("cdp_closed", "The browser went away"),
        );
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError("cdp_timeout", `${method} did not answer`));
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (value: Record<string, unknown>) => void,
          reject,
          timer,
        });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      fail(new CdpError("cdp_closed", "Closed"));
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Connect to Chromium's DevTools at `host:port` (a container name), waiting
 * up to `startupMs` for it to come up.
 */
export async function connectCdp(
  host: string,
  port: number,
  options: {
    readonly startupMs?: number;
    readonly lookup?: (host: string) => Promise<string>;
    readonly fetch?: typeof globalThis.fetch;
    readonly createSocket?: (url: string) => CdpSocket;
  } = {},
): Promise<CdpConnection> {
  const lookup =
    options.lookup ??
    (async (name: string) =>
      net.isIP(name) ? name : (await dns.lookup(name, { family: 4 })).address);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createSocket =
    options.createSocket ??
    ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const deadline = Date.now() + (options.startupMs ?? 20_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const address = await lookup(host);
      const response = await fetchImpl(
        `http://${address}:${port}/json/version`,
      );
      if (!response.ok) throw new Error(`DevTools answered ${response.status}`);
      const version = (await response.json()) as {
        webSocketDebuggerUrl?: string;
      };
      if (!version.webSocketDebuggerUrl) {
        throw new Error("DevTools gave no WebSocket address");
      }
      // The address Chromium gives may use the name it was asked by.
      const path = new URL(version.webSocketDebuggerUrl).pathname;
      const socket = createSocket(`ws://${address}:${port}${path}`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () =>
          reject(new Error("The DevTools connection failed")),
        );
      });
      return cdpConnection(socket);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new CdpError(
    "cdp_unreachable",
    `The browser did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
