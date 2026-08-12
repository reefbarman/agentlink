import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserGatewayCoreOwnerLeaseRegistration } from "../protocol.js";
import { BrowserGatewayHelperLeaseClient } from "./BrowserGatewayHelperLeaseClient.js";
import { createDeferred } from "../testing/SseFaultPeer.js";

describe("BrowserGatewayHelperLeaseClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts lease on start and release on stop", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      body?: string;
      authorization?: string;
    }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization:
          init?.headers && typeof init.headers === "object"
            ? String(
                (init.headers as Record<string, string>).Authorization ?? "",
              )
            : "",
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-1",
      clientSharedSecret: "secret-1",
      log: vi.fn(),
      renewIntervalMs: 60_000,
      leaseTtlMs: 15_000,
    });

    await client.start();
    await client.stop();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.url).toContain("/internal/client/lease");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain('"clientId":"client-1"');
    expect(calls[0]?.authorization).toBe("Bearer secret-1");
    expect(calls[calls.length - 1]?.url).toContain("/internal/client/release");
    expect(calls[calls.length - 1]?.method).toBe("POST");
    expect(calls[calls.length - 1]?.authorization).toBe("Bearer secret-1");
  });

  it("registers a neutral core owner when heartbeat is missing", async () => {
    const calls: Array<{
      url: string;
      method?: string;
      body?: string;
      authorization?: string;
    }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization:
          init?.headers && typeof init.headers === "object"
            ? String(
                (init.headers as Record<string, string>).Authorization ?? "",
              )
            : "",
      });
      const status = url.includes("/internal/core-owners/heartbeat")
        ? 404
        : 200;
      return new Response(JSON.stringify({ ok: true }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-owner",
      clientSharedSecret: "secret-owner",
      coreOwner: {
        ownerId: "owner-1",
        ownerKind: "vscode",
        displayName: "VS Code — Repo",
        scope: {
          kind: "workspace",
          workspaceId: "workspace-1",
          displayName: "Repo",
        },
        ownerGenerationId: "generation-1",
        instanceId: "instance-1",
        processId: 123,
      },
      log: vi.fn(),
      renewIntervalMs: 60_000,
      leaseTtlMs: 15_000,
    });

    await client.start();
    await client.stop();

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/internal/client/lease",
      "/internal/core-owners/heartbeat",
      "/internal/core-owners/register",
      "/internal/client/release",
    ]);
    expect(calls[2]?.body).toContain('"ownerId":"owner-1"');
    expect(calls[2]?.body).toContain('"ownerKind":"vscode"');
    expect(calls[3]?.body).toContain('"ownerGenerationId":"generation-1"');
  });

  it("forwards the latest memory runtime descriptor on owner heartbeat", async () => {
    const heartbeatBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/internal/core-owners/heartbeat") {
        heartbeatBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const coreOwner: BrowserGatewayCoreOwnerLeaseRegistration = {
      ownerId: "owner-memory",
      ownerKind: "vscode" as const,
      displayName: "VS Code — Memory",
      scope: {
        kind: "workspace" as const,
        workspaceId: "workspace-memory",
        displayName: "Memory",
      },
      ownerGenerationId: "generation-memory",
      memoryRuntime: {
        mode: "off" as const,
        retrievalStoreRoot: "/shared/retrieval-store",
      },
    };
    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-memory",
      clientSharedSecret: "secret-memory",
      coreOwner,
      log: vi.fn(),
      renewIntervalMs: 60_000,
    });

    await client.start();
    coreOwner.memoryRuntime!.mode = "autonomous";
    await client.refresh();
    await client.stop();

    expect(heartbeatBodies).toHaveLength(2);
    expect(heartbeatBodies[0]).toMatchObject({
      memoryRuntime: {
        mode: "off",
        retrievalStoreRoot: "/shared/retrieval-store",
      },
    });
    expect(heartbeatBodies[1]).toMatchObject({
      memoryRuntime: {
        mode: "autonomous",
        retrievalStoreRoot: "/shared/retrieval-store",
      },
    });
  });

  it("renews and releases a collision-assigned effective owner identity", async () => {
    const calls: Array<{ pathname: string; body: string }> = [];
    let heartbeatCount = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ pathname, body });
      if (pathname === "/internal/core-owners/heartbeat") {
        heartbeatCount += 1;
        return Response.json(
          { ok: true },
          { status: heartbeatCount === 1 ? 404 : 200 },
        );
      }
      if (pathname === "/internal/core-owners/register") {
        return Response.json({
          ok: true,
          helperGenerationId: "helper-1",
          requestedOwnerId: "owner-1",
          effectiveOwnerId: "owner-1~generation-1",
          resolution: "collision_assigned",
          ownerRegistration: {
            owner: { ownerId: "owner-1~generation-1" },
            ownerGenerationId: "generation-1",
            status: "connected",
            capabilities: [],
          },
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-collision",
      clientSharedSecret: "secret-collision",
      coreOwner: {
        ownerId: "owner-1",
        ownerKind: "vscode",
        displayName: "VS Code — Repo",
        scope: {
          kind: "workspace",
          workspaceId: "workspace-1",
          displayName: "Repo",
        },
        ownerGenerationId: "generation-1",
      },
      log: vi.fn(),
      renewIntervalMs: 60_000,
    });

    await client.start();
    await (client as unknown as { renewLease(): Promise<void> }).renewLease();
    await client.stop();

    const secondHeartbeat = calls.filter(
      (call) => call.pathname === "/internal/core-owners/heartbeat",
    )[1];
    const release = calls.find(
      (call) => call.pathname === "/internal/client/release",
    );
    expect(client.getEffectiveOwnerId()).toBe("owner-1~generation-1");
    expect(secondHeartbeat?.body).toContain('"ownerId":"owner-1~generation-1"');
    expect(release?.body).toContain('"ownerId":"owner-1~generation-1"');
  });

  it("registers a neutral core owner when heartbeat generation is stale", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      calls.push(new URL(url).pathname);
      const status = url.includes("/internal/core-owners/heartbeat")
        ? 404
        : 200;
      return new Response(JSON.stringify({ ok: true }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-rollover",
      clientSharedSecret: "secret-rollover",
      coreOwner: {
        ownerId: "owner-1",
        ownerKind: "vscode",
        displayName: "VS Code — Repo",
        scope: {
          kind: "workspace",
          workspaceId: "workspace-1",
          displayName: "Repo",
        },
        ownerGenerationId: "generation-2",
      },
      log: vi.fn(),
      renewIntervalMs: 60_000,
      leaseTtlMs: 15_000,
    });

    await client.start();
    await client.stop();

    expect(calls).toEqual([
      "/internal/client/lease",
      "/internal/core-owners/heartbeat",
      "/internal/core-owners/register",
      "/internal/client/release",
    ]);
  });

  it("coalesces concurrent renewal triggers into one request", async () => {
    const renewalResponse = createDeferred<Response>();
    let leaseRequests = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/internal/client/lease") {
        leaseRequests += 1;
        if (leaseRequests === 2) return renewalResponse.promise;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-single-flight",
      clientSharedSecret: "secret-single-flight",
      log: vi.fn(),
      renewIntervalMs: 60_000,
      renewJitterRatio: 0,
    });
    await client.start();

    const internal = client as unknown as { renewLease(): Promise<void> };
    const first = internal.renewLease();
    const second = internal.renewLease();

    expect(first).toBe(second);
    expect(leaseRequests).toBe(2);

    renewalResponse.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await Promise.all([first, second]);
    await client.stop();
  });

  it("settles a hung abort-ignoring renewal at its deadline", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let leaseSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/internal/client/lease") {
        leaseSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-timeout",
      clientSharedSecret: "secret-timeout",
      log,
      requestTimeoutMs: 100,
      renewIntervalMs: 60_000,
      renewJitterRatio: 0,
    });

    const start = client.start();
    await vi.advanceTimersByTimeAsync(100);
    await expect(start).resolves.toBeUndefined();

    expect(leaseSignal?.aborted).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "[browser-gateway-helper] lease refresh timed out after 100ms",
    );
    await client.stop();
  });

  it("schedules the next renewal after completion using bounded jitter", async () => {
    vi.useFakeTimers();
    let leaseRequests = 0;
    globalThis.fetch = vi.fn(async () => {
      leaseRequests += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-jitter",
      clientSharedSecret: "secret-jitter",
      log: vi.fn(),
      renewIntervalMs: 1_000,
      renewJitterRatio: 0.2,
      random: () => 1,
    });
    await client.start();

    await vi.advanceTimersByTimeAsync(1_199);
    expect(leaseRequests).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(leaseRequests).toBe(2);

    await client.stop();
  });

  it("logs but does not throw when lease refresh fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network_down");
    }) as typeof fetch;

    const log = vi.fn();
    const client = new BrowserGatewayHelperLeaseClient({
      helperUrl: "http://127.0.0.1:47137",
      clientId: "client-2",
      clientSharedSecret: "secret-2",
      log,
      renewIntervalMs: 60_000,
      leaseTtlMs: 15_000,
    });

    await client.start();
    await client.stop();

    expect(log).toHaveBeenCalled();
  });
});
