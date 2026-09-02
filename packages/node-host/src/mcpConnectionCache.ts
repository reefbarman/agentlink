import type { AgentPrincipal } from "@agentlink/core";
import { createHash } from "node:crypto";

/** Stable identity for one host-approved remote MCP connection configuration. */
export interface NodeHostMcpConnectionDescriptor {
  readonly serverId: string;
  readonly transport: "sse" | "streamable-http";
  readonly url: string;
  /** Included only as a digest input; the cache never exposes header values. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface NodeHostMcpConnectionLease<TConnection> {
  readonly connection: TConnection;
  readonly key: string;
  release(): void;
}

export interface NodeHostMcpConnectionCacheOptions<TConnection> {
  readonly connect: (
    descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
  ) => Promise<TConnection>;
  readonly close: (connection: TConnection) => Promise<void> | void;
}

interface CachedConnection<TConnection> {
  readonly connection: TConnection;
  leases: number;
  retired: boolean;
  closePromise?: Promise<void>;
}

/**
 * Host-owned in-process connection cache. It never authorizes network access:
 * callers must bind per-request network policy to their transport separately.
 *
 * The key includes tenant, subject, server id, endpoint, transport, and every
 * effective header value by SHA-256 digest. Thus configurations or credentials
 * from different principals cannot share a connection accidentally.
 */
export class NodeHostMcpConnectionCache<
  TConnection,
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  private readonly entries = new Map<string, CachedConnection<TConnection>>();
  private readonly connecting = new Map<
    string,
    Promise<CachedConnection<TConnection>>
  >();

  constructor(
    private readonly options: NodeHostMcpConnectionCacheOptions<TConnection>,
  ) {}

  async acquire(
    principal: TPrincipal,
    descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
  ): Promise<NodeHostMcpConnectionLease<TConnection>> {
    const key = nodeHostMcpConnectionKey(principal, descriptor);
    let entry = this.entries.get(key);
    if (!entry || entry.retired) {
      entry = await this.connect(key, descriptor);
    }
    entry.leases += 1;
    let released = false;
    return {
      key,
      connection: entry.connection,
      release: () => {
        if (released) return;
        released = true;
        entry!.leases -= 1;
        if (entry!.retired && entry!.leases === 0) void this.close(key, entry!);
      },
    };
  }

  /** Retire exactly one principal/configuration connection without affecting peers. */
  async invalidate(
    principal: TPrincipal,
    descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
  ): Promise<void> {
    const key = nodeHostMcpConnectionKey(principal, descriptor);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.retired = true;
    if (entry.leases === 0) await this.close(key, entry);
  }

  /** Retire all cached connections, waiting only for actively leased calls to finish. */
  async dispose(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      entry.retired = true;
      if (entry.leases === 0) closing.push(this.close(key, entry));
    }
    await Promise.all(closing);
  }

  private async connect(
    key: string,
    descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
  ): Promise<CachedConnection<TConnection>> {
    const existing = this.connecting.get(key);
    if (existing) return existing;
    const pending = this.options
      .connect(cloneDescriptor(descriptor))
      .then((connection) => {
        const entry: CachedConnection<TConnection> = {
          connection,
          leases: 0,
          retired: false,
        };
        this.entries.set(key, entry);
        return entry;
      });
    this.connecting.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.connecting.get(key) === pending) this.connecting.delete(key);
    }
  }

  private close(
    key: string,
    entry: CachedConnection<TConnection>,
  ): Promise<void> {
    entry.closePromise ??= Promise.resolve(
      this.options.close(entry.connection),
    ).finally(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.closePromise;
  }
}

/** Produce a secret-safe opaque cache key; callers must not treat it as an authorization grant. */
export function nodeHostMcpConnectionKey(
  principal: AgentPrincipal,
  descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
): string {
  requiredText(principal.tenantId, "principal.tenantId");
  requiredText(principal.subjectId, "principal.subjectId");
  validateDescriptor(descriptor);
  return createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: principal.tenantId,
        subjectId: principal.subjectId,
        serverId: descriptor.serverId,
        transport: descriptor.transport,
        url: descriptor.url,
        headers: Object.entries(descriptor.headers ?? {}).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      }),
    )
    .digest("hex");
}

function validateDescriptor(
  descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
): void {
  requiredText(descriptor.serverId, "serverId");
  requiredText(descriptor.url, "url");
  if (
    descriptor.transport !== "sse" &&
    descriptor.transport !== "streamable-http"
  ) {
    throw new Error("MCP connection transport must be sse or streamable-http");
  }
}

function cloneDescriptor(
  descriptor: Readonly<NodeHostMcpConnectionDescriptor>,
): NodeHostMcpConnectionDescriptor {
  return {
    serverId: descriptor.serverId,
    transport: descriptor.transport,
    url: descriptor.url,
    ...(descriptor.headers ? { headers: { ...descriptor.headers } } : {}),
  };
}

function requiredText(value: string, field: string): void {
  if (!value.trim())
    throw new Error(`MCP connection ${field} must not be empty`);
}
