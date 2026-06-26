import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayHelperLeaseClient } from "./BrowserGatewayHelperLeaseClient.js";

describe("BrowserGatewayHelperLeaseClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
