import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentPluginSseClientTransport } from "./AgentPluginSseClientTransport.js";
import { createAgentPluginMcpFetch } from "./agentPluginHttpFetch.js";

const eventSourceMocks = vi.hoisted(() => ({
  endpointData: "/messages",
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    emitEndpoint: (data: string) => void;
  }>,
}));

vi.mock("eventsource", () => ({
  EventSource: class MockEventSource {
    onerror?: (event: { code?: number; message?: string }) => void;
    onmessage?: (event: MessageEvent<string>) => void;
    private endpointListener?: (event: MessageEvent<string>) => void;
    readonly close = vi.fn();

    constructor(
      url: URL,
      options: {
        fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
      },
    ) {
      const instance = {
        close: this.close,
        emitEndpoint: (data: string) =>
          this.endpointListener?.({ data } as MessageEvent<string>),
      };
      eventSourceMocks.instances.push(instance);
      queueMicrotask(async () => {
        try {
          await options.fetch(url, {
            headers: { accept: "text/event-stream" },
          });
          instance.emitEndpoint(eventSourceMocks.endpointData);
        } catch (error) {
          this.onerror?.({ message: String(error) });
        }
      });
    }

    addEventListener(
      type: string,
      listener: (event: MessageEvent<string>) => void,
    ): void {
      if (type === "endpoint") this.endpointListener = listener;
    }
  },
}));

function response(
  status: number,
  url: string,
  headers: Record<string, string> = {},
): Response {
  const value = new Response(null, { status, headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

describe("AgentPluginSseClientTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventSourceMocks.endpointData = "/messages";
    eventSourceMocks.instances.length = 0;
  });

  it("resolves endpoint events against the redirected SSE response and omits package headers cross-origin", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> =
      [];
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
        });
        if (url === "https://mcp.example.test/events") {
          return response(302, url, {
            location: "https://relay.example.test/sse",
          });
        }
        return response(200, url);
      },
    ) as typeof globalThis.fetch;
    eventSourceMocks.endpointData = "../messages";
    const transport = new AgentPluginSseClientTransport(
      new URL("https://mcp.example.test/events"),
      {
        mcpFetch: createAgentPluginMcpFetch(
          "https://mcp.example.test/events",
          { Authorization: "package-token", "X-Plugin": "fixture" },
          baseFetch,
        ),
        oauthFetch: baseFetch,
      },
    );

    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(requests.map((request) => request.url)).toEqual([
      "https://mcp.example.test/events",
      "https://relay.example.test/sse",
      "https://relay.example.test/messages",
    ]);
    expect(requests[0]?.headers.get("x-plugin")).toBe("fixture");
    expect(requests[1]?.headers.get("x-plugin")).toBeNull();
    expect(requests[2]?.headers.get("x-plugin")).toBeNull();
    expect(requests[2]?.headers.get("authorization")).toBeNull();
  });

  it("restores configured headers when the endpoint returns to the configured origin", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const baseFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url === "https://mcp.example.test/events") {
          return response(302, url, {
            location: "https://relay.example.test/sse",
          });
        }
        return response(200, url);
      },
    ) as typeof globalThis.fetch;
    eventSourceMocks.endpointData = "https://mcp.example.test/messages";
    const transport = new AgentPluginSseClientTransport(
      new URL("https://mcp.example.test/events"),
      {
        mcpFetch: createAgentPluginMcpFetch(
          "https://mcp.example.test/events",
          { "X-Plugin": "fixture" },
          baseFetch,
        ),
        oauthFetch: baseFetch,
      },
    );

    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(requests.at(-1)?.url).toBe("https://mcp.example.test/messages");
    expect(requests.at(-1)?.headers.get("x-plugin")).toBe("fixture");
    expect(requests.at(-1)?.headers.has("origin")).toBe(false);
  });

  it.each([
    ["non-HTTP scheme", "file:///tmp/socket", "URL must use HTTP or HTTPS"],
    [
      "non-loopback downgrade",
      "http://example.test/messages",
      "Plain HTTP is allowed only",
    ],
  ])(
    "rejects an endpoint event with a %s",
    async (_label, endpoint, message) => {
      eventSourceMocks.endpointData = endpoint;
      const mcpFetch = vi.fn(async () =>
        response(200, "https://mcp.example.test/events"),
      ) as typeof globalThis.fetch;
      const transport = new AgentPluginSseClientTransport(
        new URL("https://mcp.example.test/events"),
        { mcpFetch, oauthFetch: mcpFetch },
      );

      await expect(transport.start()).rejects.toThrow(message);
      expect(eventSourceMocks.instances[0]?.close).toHaveBeenCalled();
    },
  );
});
