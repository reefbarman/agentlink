import {
  NodeHostMcpConnectionCache,
  nodeHostMcpConnectionKey,
} from "./mcpConnectionCache.js";
import { describe, expect, it, vi } from "vitest";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const otherPrincipal = { tenantId: "tenant-a", subjectId: "subject-b" };
const descriptor = {
  serverId: "records",
  transport: "streamable-http" as const,
  url: "https://mcp.example.test/mcp",
  headers: { Authorization: "Bearer tenant-secret" },
};

describe("node host MCP connection cache", () => {
  it("partitions connections by principal and complete effective configuration", async () => {
    let sequence = 0;
    const connect = vi.fn(async () => ({ id: ++sequence }));
    const close = vi.fn(async () => {});
    const cache = new NodeHostMcpConnectionCache({ connect, close });

    const first = await cache.acquire(principal, descriptor);
    const same = await cache.acquire(principal, descriptor);
    const other = await cache.acquire(otherPrincipal, descriptor);
    const rotatedHeader = await cache.acquire(principal, {
      ...descriptor,
      headers: { Authorization: "Bearer rotated-secret" },
    });

    expect(first.connection).toBe(same.connection);
    expect(other.connection).not.toBe(first.connection);
    expect(rotatedHeader.connection).not.toBe(first.connection);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(first.key).not.toContain("tenant-secret");
    expect(first.key).toBe(nodeHostMcpConnectionKey(principal, descriptor));

    first.release();
    same.release();
    other.release();
    rotatedHeader.release();
    await cache.dispose();
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("shares concurrent creation, retires only the targeted entry, and waits for active leases", async () => {
    let resolveConnect!: (connection: { id: string }) => void;
    const connect = vi
      .fn<() => Promise<{ id: string }>>()
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => (resolveConnect = resolve)),
      )
      .mockResolvedValueOnce({ id: "replacement" });
    const close = vi.fn(async () => {});
    const cache = new NodeHostMcpConnectionCache({ connect, close });

    const first = cache.acquire(principal, descriptor);
    const second = cache.acquire(principal, descriptor);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    resolveConnect({ id: "shared" });
    const [one, two] = await Promise.all([first, second]);
    expect(one.connection).toBe(two.connection);

    await cache.invalidate(principal, descriptor);
    expect(close).not.toHaveBeenCalled();
    one.release();
    expect(close).not.toHaveBeenCalled();
    two.release();
    await vi.waitFor(() =>
      expect(close).toHaveBeenCalledWith({ id: "shared" }),
    );

    const replacement = await cache.acquire(principal, descriptor);
    expect(replacement.connection).not.toBe(one.connection);
    replacement.release();
    await cache.dispose();
  });
});
