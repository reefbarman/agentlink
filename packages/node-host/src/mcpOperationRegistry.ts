interface OperationMember {
  readonly signal: AbortSignal | undefined;
}

interface OperationGroup {
  readonly controller: AbortController;
  readonly members: Set<OperationMember>;
}

export interface McpOperationClaim<TOwner> {
  readonly owner: TOwner;
  /** Aborts once every operation this owner has in flight on the server has ended or been cancelled. */
  readonly signal: AbortSignal;
}

/**
 * Tracks in-flight MCP operations per server so a server-initiated request
 * (such as elicitation) can be routed to the owner that caused it. Concurrent
 * operations from one owner share a claim; live operations from more than one
 * owner make the request ambiguous, so no claim is returned.
 */
export class McpOperationRegistry<TOwner> {
  private readonly servers = new Map<string, Map<TOwner, OperationGroup>>();

  async run<T>(
    serverName: string,
    owner: TOwner,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    let owners = this.servers.get(serverName);
    if (!owners) {
      owners = new Map();
      this.servers.set(serverName, owners);
    }
    let group = owners.get(owner);
    if (!group) {
      group = { controller: new AbortController(), members: new Set() };
      owners.set(owner, group);
    }
    const joined = group;
    const member: OperationMember = { signal };
    joined.members.add(member);
    const settle = () => this.settle(serverName, owner, joined);
    signal?.addEventListener("abort", settle, { once: true });
    try {
      return await operation();
    } finally {
      signal?.removeEventListener("abort", settle);
      joined.members.delete(member);
      settle();
    }
  }

  cancelOwner(owner: TOwner): void {
    for (const [serverName, owners] of this.servers) {
      const group = owners.get(owner);
      if (!group) continue;
      group.controller.abort();
      owners.delete(owner);
      if (owners.size === 0) this.servers.delete(serverName);
    }
  }

  claim(serverName: string): McpOperationClaim<TOwner> | undefined {
    const live = [...(this.servers.get(serverName) ?? [])].filter(([, group]) =>
      isLive(group),
    );
    const [entry] = live;
    if (live.length !== 1 || !entry) return undefined;
    const [owner, group] = entry;
    return { owner, signal: group.controller.signal };
  }

  private settle(serverName: string, owner: TOwner, group: OperationGroup) {
    if (isLive(group)) return;
    group.controller.abort();
    const owners = this.servers.get(serverName);
    if (owners?.get(owner) !== group) return;
    owners.delete(owner);
    if (owners.size === 0) this.servers.delete(serverName);
  }
}

function isLive(group: OperationGroup): boolean {
  return [...group.members].some((member) => !member.signal?.aborted);
}
