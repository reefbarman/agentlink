import { describe, expect, it, vi } from "vitest";

import { createAgentPluginMcpFetch } from "./agentPluginHttpFetch.js";

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}

function response(
  status = 200,
  options: { readonly location?: string; readonly url?: string } = {},
): Response {
  const value = new Response(null, {
    status,
    headers: options.location ? { location: options.location } : undefined,
  });
  if (options.url) {
    Object.defineProperty(value, "url", { value: options.url });
  }
  return value;
}

function sequence(...responses: Response[]) {
  const requests: CapturedRequest[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      init: { ...init },
      headers: new Headers(init?.headers),
    });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    return next;
  });
  return { fetch, requests };
}

const mcpBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
});

function mcpInit(overrides: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: mcpBody,
    ...overrides,
  };
}

describe("createAgentPluginMcpFetch", () => {
  it("injects package headers only for same-origin MCP requests with client precedence", async () => {
    const base = sequence(response());
    const fetch = createAgentPluginMcpFetch(
      "https://mcp.example.test/rpc",
      {
        Authorization: "Package token",
        "X-Plugin": "package",
      },
      base.fetch,
    );

    await fetch(
      "https://mcp.example.test/rpc",
      mcpInit({
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          authorization: "Bearer oauth",
        },
      }),
    );

    expect(base.requests[0]!.headers.get("authorization")).toBe("Bearer oauth");
    expect(base.requests[0]!.headers.get("x-plugin")).toBe("package");
    expect(base.requests[0]!.headers.has("origin")).toBe(false);
    expect(base.requests[0]!.init.redirect).toBe("manual");
  });

  it("keeps package headers out of same-origin OAuth discovery, registration, and token requests", async () => {
    const base = sequence(response(), response(), response());
    const fetch = createAgentPluginMcpFetch(
      "https://mcp.example.test/rpc",
      { Authorization: "Package token", "X-Plugin": "package" },
      base.fetch,
    );

    await fetch(
      "https://mcp.example.test/.well-known/oauth-authorization-server",
      {
        headers: { Accept: "application/json" },
      },
    );
    await fetch("https://mcp.example.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "AgentLink" }),
    });
    await fetch("https://mcp.example.test/token", {
      method: "POST",
      headers: {
        Authorization: "Basic oauth-client",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });

    for (const request of base.requests) {
      expect(request.headers.has("x-plugin")).toBe(false);
    }
    expect(base.requests[0]!.headers.has("authorization")).toBe(false);
    expect(base.requests[1]!.headers.has("authorization")).toBe(false);
    expect(base.requests[2]!.headers.get("authorization")).toBe(
      "Basic oauth-client",
    );
  });

  it("drops package and credential headers cross-origin and restores package headers on return", async () => {
    const base = sequence(
      response(307, { location: "https://foreign.example.test/relay" }),
      response(307, { location: "https://mcp.example.test/final" }),
      response(),
    );
    const fetch = createAgentPluginMcpFetch(
      "https://mcp.example.test/rpc",
      { "X-Plugin": "package" },
      base.fetch,
    );

    await fetch(
      "https://mcp.example.test/rpc",
      mcpInit({
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Authorization: "Bearer oauth",
          Cookie: "session=secret",
        },
      }),
    );

    expect(base.requests[0]!.headers.get("x-plugin")).toBe("package");
    expect(base.requests[1]!.headers.has("x-plugin")).toBe(false);
    expect(base.requests[1]!.headers.has("authorization")).toBe(false);
    expect(base.requests[1]!.headers.has("cookie")).toBe(false);
    expect(base.requests[2]!.headers.get("x-plugin")).toBe("package");
    expect(base.requests[2]!.headers.get("authorization")).toBe("Bearer oauth");
  });

  it.each([301, 302] as const)(
    "rewrites POST to GET and drops the body for %s redirects",
    async (status) => {
      const base = sequence(
        response(status, { location: "/next" }),
        response(),
      );
      const fetch = createAgentPluginMcpFetch(
        "https://mcp.example.test/rpc",
        undefined,
        base.fetch,
      );

      await fetch("https://mcp.example.test/rpc", mcpInit());

      expect(base.requests[1]!.init.method).toBe("GET");
      expect(base.requests[1]!.init.body).toBeUndefined();
      expect(base.requests[1]!.headers.has("content-type")).toBe(false);
    },
  );

  it("applies 303 HEAD/GET rules and preserves replayable 307/308 requests", async () => {
    const headBase = sequence(response(303, { location: "/next" }), response());
    await createAgentPluginMcpFetch(
      "https://mcp.example.test/rpc",
      undefined,
      headBase.fetch,
    )("https://mcp.example.test/rpc", {
      method: "HEAD",
      headers: { Accept: "text/event-stream" },
    });
    expect(headBase.requests[1]!.init.method).toBe("HEAD");

    for (const status of [307, 308]) {
      const base = sequence(
        response(status, { location: "/next" }),
        response(),
      );
      await createAgentPluginMcpFetch(
        "https://mcp.example.test/rpc",
        undefined,
        base.fetch,
      )("https://mcp.example.test/rpc", mcpInit());
      expect(base.requests[1]!.init.method).toBe("POST");
      expect(base.requests[1]!.init.body).toBe(mcpBody);
    }
  });

  it("rejects one-shot replay, loops, excessive hops, and non-loopback downgrades", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const replayBase = sequence(response(307, { location: "/next" }));
    await expect(
      createAgentPluginMcpFetch(
        "https://mcp.example.test/rpc",
        undefined,
        replayBase.fetch,
      )("https://mcp.example.test/rpc", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    ).rejects.toThrow("one-shot request body");

    const loopBase = sequence(
      response(307, { location: "/next" }),
      response(307, { location: "/rpc" }),
    );
    await expect(
      createAgentPluginMcpFetch(
        "https://mcp.example.test/rpc",
        undefined,
        loopBase.fetch,
      )("https://mcp.example.test/rpc", mcpInit()),
    ).rejects.toThrow("redirect loop");

    const redirects = Array.from({ length: 6 }, (_, index) =>
      response(307, { location: `/hop-${index + 1}` }),
    );
    await expect(
      createAgentPluginMcpFetch(
        "https://mcp.example.test/rpc",
        undefined,
        sequence(...redirects).fetch,
      )("https://mcp.example.test/rpc", mcpInit()),
    ).rejects.toThrow("redirect limit exceeded");

    const downgradeBase = sequence(
      response(307, { location: "http://example.test/insecure" }),
    );
    await expect(
      createAgentPluginMcpFetch(
        "https://mcp.example.test/rpc",
        undefined,
        downgradeBase.fetch,
      )("https://mcp.example.test/rpc", mcpInit()),
    ).rejects.toThrow("Plain HTTP is allowed only");
  });

  it("allows an HTTPS redirect to independently valid loopback HTTP", async () => {
    const base = sequence(
      response(307, { location: "http://127.0.0.1:3000/mcp" }),
      response(),
    );
    await createAgentPluginMcpFetch(
      "https://mcp.example.test/rpc",
      undefined,
      base.fetch,
    )("https://mcp.example.test/rpc", mcpInit());
    expect(base.requests[1]!.url).toBe("http://127.0.0.1:3000/mcp");
  });
});
