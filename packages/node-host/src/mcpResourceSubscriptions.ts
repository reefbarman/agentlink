import type {
  Client,
  McpSubscription,
  Transport,
} from "@modelcontextprotocol/client";

import { AsyncLocalStorage } from "node:async_hooks";

/** Shared retry policy for catalog and resource subscription streams. */
export const MCP_RELISTEN_POLICY = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 6,
  stableMs: 60_000,
} as const;

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const FAILURE =
  "MCP resource subscription unavailable. Reconnect the server to retry.";

export interface ResourceSubscriptionOptions {
  readonly meta?: (client: Client) => Record<string, unknown> | undefined;
  readonly onUpdated: (uri: string) => void;
  readonly onError: (error: string) => void;
  readonly onReconnected?: () => void;
}

interface Watch {
  readonly sessionId: string;
  readonly uris: Set<string>;
  readonly options: ResourceSubscriptionOptions;
  controller?: AbortController;
  subscription?: McpSubscription;
  subscriptionId?: string | number;
  timer?: ReturnType<typeof setTimeout>;
}

interface Connection {
  readonly client: Client;
  readonly controller: AbortController;
  readonly subscribed: Set<string>;
  readonly restoreSend: () => void;
  queue: Promise<void>;
}

/** One manager per server definition, sharing its existing client and transport. */
export class McpResourceSubscriptions {
  private readonly watches = new Map<string, Watch>();
  private readonly opening = new AsyncLocalStorage<Watch>();
  private connection?: Connection;

  attach(client: Client, transport: Transport): void {
    this.detach();
    const originalSend = transport.send;
    // SDK 2.4's McpSubscription omits its ID and listen() has no request-meta
    // option. Observe only our scoped listen sends, without predicting SDK IDs
    // or replacing the SDK's notification demultiplexer/catalog stream.
    const send: Transport["send"] = (message, options) => {
      const watch = this.opening.getStore();
      if (
        watch &&
        "method" in message &&
        message.method === "subscriptions/listen" &&
        "id" in message
      ) {
        watch.subscriptionId = message.id;
        message = {
          ...message,
          params: {
            ...message.params,
            _meta: {
              ...message.params?._meta,
              ...watch.options.meta?.(client),
            },
          },
        };
      }
      return originalSend.call(transport, message, options);
    };
    transport.send = send;
    const connection: Connection = {
      client,
      controller: new AbortController(),
      subscribed: new Set(),
      queue: Promise.resolve(),
      restoreSend: () => {
        if (transport.send === send) transport.send = originalSend;
      },
    };
    this.connection = connection;
    client.setNotificationHandler(
      "notifications/resources/updated",
      (notification) => {
        if (this.connection !== connection) return;
        const { uri, _meta } = notification.params;
        const id = _meta?.[SUBSCRIPTION_ID];
        for (const watch of this.watches.values()) {
          if (!watch.uris.has(uri)) continue;
          if (client.getProtocolEra() === "modern") {
            if (
              watch.subscriptionId === undefined ||
              id !== watch.subscriptionId ||
              !watch.subscription
            )
              continue;
          } else if (!connection.subscribed.has(uri)) continue;
          this.updated(watch, uri);
        }
      },
    );
    for (const watch of this.watches.values()) {
      void this.open(watch, connection, true).catch(() => {
        if (this.isCurrent(watch, connection)) this.failed(watch);
      });
    }
  }

  detach(): void {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    connection.controller.abort();
    connection.restoreSend();
    for (const watch of this.watches.values()) {
      void this.close(watch);
    }
  }

  async dispose(): Promise<void> {
    const connection = this.connection;
    // Abort openings before waiting for any cleanup. In particular a legacy
    // subscribe waiting for its reply must not hold hub shutdown hostage.
    this.detach();
    this.watches.clear();
    if (connection && connection.client.getProtocolEra() !== "modern") {
      await connection.queue.catch(() => undefined);
      await Promise.all(
        [...connection.subscribed].map((uri) =>
          connection.client.unsubscribeResource({ uri }).catch(() => undefined),
        ),
      );
    }
  }

  async subscribe(
    sessionId: string,
    uris: readonly string[],
    options: ResourceSubscriptionOptions,
  ): Promise<{ dispose(): Promise<void> }> {
    const connection = this.connection;
    if (
      !connection ||
      !connection.client.getServerCapabilities()?.resources?.subscribe
    )
      throw new Error(FAILURE);
    const previous = this.watches.get(sessionId);
    const watch: Watch = { sessionId, uris: new Set(uris), options };
    this.watches.set(sessionId, watch);
    if (previous) await this.close(previous);
    try {
      if (this.isCurrent(watch, connection))
        await this.open(watch, connection, false);
    } catch {
      // Replacement/disconnect cancels the old opening. It must not tear down
      // the replacement, or a new stream already opened during reconnect.
      if (this.isCurrent(watch, connection)) {
        this.watches.delete(sessionId);
        await this.close(watch);
        await this.reconcileLegacy(connection).catch(() => undefined);
        this.failed(watch);
        throw new Error(FAILURE);
      }
    }
    return {
      dispose: async () => {
        if (this.watches.get(sessionId) !== watch) return;
        this.watches.delete(sessionId);
        await this.close(watch);
        const current = this.connection;
        if (current)
          await this.reconcileLegacy(current).catch(() => this.failed(watch));
      },
    };
  }

  private isCurrent(watch: Watch, connection: Connection): boolean {
    return (
      this.connection === connection &&
      this.watches.get(watch.sessionId) === watch
    );
  }

  private async open(
    watch: Watch,
    connection: Connection,
    catchUp: boolean,
    attempt = 0,
  ): Promise<void> {
    if (!this.isCurrent(watch, connection)) return;
    if (!connection.client.getServerCapabilities()?.resources?.subscribe)
      throw new Error(FAILURE);
    if (connection.client.getProtocolEra() !== "modern") {
      await this.reconcileLegacy(connection, watch);
    } else if (watch.uris.size) {
      const controller = new AbortController();
      watch.controller = controller;
      const subscription = await this.opening.run(watch, () =>
        connection.client.listen(
          { resourceSubscriptions: [...watch.uris] },
          {
            signal: AbortSignal.any([
              controller.signal,
              connection.controller.signal,
            ]),
          },
        ),
      );
      if (!this.isCurrent(watch, connection) || controller.signal.aborted) {
        await subscription.close();
        return;
      }
      const honored = new Set(subscription.honoredFilter.resourceSubscriptions);
      if ([...watch.uris].some((uri) => !honored.has(uri))) {
        await subscription.close();
        throw new Error(FAILURE);
      }
      watch.subscription = subscription;
      const openedAt = Date.now();
      void subscription.closed.then((cause) => {
        if (
          !this.isCurrent(watch, connection) ||
          watch.subscription !== subscription
        )
          return;
        watch.subscription = undefined;
        watch.subscriptionId = undefined;
        if (cause === "remote")
          this.schedule(
            watch,
            connection,
            Date.now() - openedAt >= MCP_RELISTEN_POLICY.stableMs ? 0 : attempt,
          );
        else if (cause === "graceful") this.failed(watch);
      });
      // The peer can acknowledge and close in the same transport turn. Let
      // that already-settled close run before claiming a live restored stream.
      await Promise.resolve();
      if (watch.subscription !== subscription) return;
    }
    if (catchUp && this.isCurrent(watch, connection)) {
      if (watch.options.onReconnected) {
        try {
          watch.options.onReconnected();
        } catch {
          /* Isolate consumer callbacks. */
        }
      } else {
        for (const uri of watch.uris) this.updated(watch, uri);
      }
    }
  }

  private schedule(
    watch: Watch,
    connection: Connection,
    attempt: number,
  ): void {
    if (!this.isCurrent(watch, connection)) return;
    if (attempt >= MCP_RELISTEN_POLICY.maxAttempts) {
      this.failed(watch);
      return;
    }
    watch.timer = setTimeout(
      () => {
        watch.timer = undefined;
        if (!this.isCurrent(watch, connection)) return;
        void this.open(watch, connection, true, attempt + 1).catch(() =>
          this.schedule(watch, connection, attempt + 1),
        );
      },
      Math.min(
        MCP_RELISTEN_POLICY.baseDelayMs * 2 ** attempt,
        MCP_RELISTEN_POLICY.maxDelayMs,
      ),
    );
  }

  /** Serialize the union of watched URIs, so subscribe/unsubscribe cannot race. */
  private reconcileLegacy(
    connection: Connection,
    acquire?: Watch,
  ): Promise<void> {
    if (connection.client.getProtocolEra() === "modern")
      return Promise.resolve();
    const work = connection.queue
      .catch(() => undefined)
      .then(async () => {
        if (
          this.connection !== connection ||
          (acquire && !this.isCurrent(acquire, connection))
        )
          return;
        const desired = new Set<string>();
        for (const watch of this.watches.values())
          for (const uri of watch.uris) desired.add(uri);
        // Acquire only this watch's URIs. A rejected URI in another session
        // must not fail an otherwise healthy subscription sharing the client.
        for (const uri of acquire?.uris ?? []) {
          if (connection.subscribed.has(uri)) continue;
          const meta = acquire?.options.meta?.(connection.client);
          await connection.client.subscribeResource(
            {
              uri,
              ...(meta ? { _meta: meta } : {}),
            },
            { signal: connection.controller.signal },
          );
          if (this.connection !== connection) return;
          connection.subscribed.add(uri);
        }
        for (const uri of connection.subscribed) {
          if (desired.has(uri)) continue;
          await connection.client.unsubscribeResource(
            { uri },
            { signal: connection.controller.signal },
          );
          connection.subscribed.delete(uri);
        }
      });
    connection.queue = work;
    return work;
  }

  private async close(watch: Watch): Promise<void> {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = undefined;
    watch.subscriptionId = undefined;
    watch.controller?.abort();
    const subscription = watch.subscription;
    watch.subscription = undefined;
    await subscription?.close().catch(() => undefined);
  }

  private updated(watch: Watch, uri: string): void {
    try {
      watch.options.onUpdated(uri);
    } catch {
      /* Consumer callbacks cannot break shared transport delivery. */
    }
  }

  private failed(watch: Watch): void {
    try {
      watch.options.onError(FAILURE);
    } catch {
      /* Consumer callbacks cannot break shared transport delivery. */
    }
  }
}
