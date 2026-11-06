import {
  createCodexIdentityDiagnosticConnector,
  createCodexIdentityDiagnosticFetch,
} from "./requestIdentityDiagnostics.js";
import {
  createOpenAiResponsesClient,
  getCodexEndpointConfig,
} from "./openaiClient.js";
import { describe, expect, it, vi } from "vitest";

const headers = {
  originator: "diagnostic-client",
  "User-Agent": "diagnostic-client/7.8.9",
  version: "7.8.9",
  "OpenAI-Beta": "responses_websockets=2026-02-06",
  "x-openai-internal-codex-responses-lite": "true",
  Authorization: "Bearer PRIVATE_TOKEN",
  "ChatGPT-Account-Id": "PRIVATE_ACCOUNT",
  session_id: "PRIVATE_SESSION",
  "session-id": "PRIVATE_SESSION",
  "thread-id": "PRIVATE_THREAD",
  "x-codex-turn-state": "PRIVATE_ROUTING",
  "x-future-header": "PRIVATE_FUTURE",
};
const expected = {
  originator: "diagnostic-client",
  userAgent: "diagnostic-client/7.8.9",
  version: "7.8.9",
  openAIBeta: "responses_websockets=2026-02-06",
  responsesLite: "true",
};

describe("Codex request identity diagnostics", () => {
  it("projects only fixed fields and preserves fetch arguments and response", async () => {
    const response = new Response("ok");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const observer = vi.fn();
    const init = { headers, body: "PRIVATE_BODY", method: "POST" };
    const wrapped = createCodexIdentityDiagnosticFetch(fetch, observer);
    expect(await wrapped("https://example.com", init)).toBe(response);
    expect(fetch.mock.calls[0][1]).toBe(init);
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      transport: "http",
      ...expected,
    });
    expect(JSON.stringify(observer.mock.calls)).not.toContain("PRIVATE_");
  });

  it("uses Request headers unless init replaces them", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response());
    const observer = vi.fn();
    const wrapped = createCodexIdentityDiagnosticFetch(fetch, observer);
    const request = new Request("https://example.com", { headers });
    await wrapped(request);
    expect(observer).toHaveBeenLastCalledWith({
      transport: "http",
      ...expected,
    });
    await wrapped(request, { headers: { version: "replacement" } });
    expect(observer).toHaveBeenLastCalledWith({
      transport: "http",
      originator: null,
      userAgent: null,
      version: "replacement",
      openAIBeta: null,
      responsesLite: null,
    });
    await wrapped(request, { headers: {} });
    expect(observer).toHaveBeenLastCalledWith({
      transport: "http",
      originator: null,
      userAgent: null,
      version: null,
      openAIBeta: null,
      responsesLite: null,
    });
  });

  it("observes final SDK defaults and request-specific overrides", async () => {
    const observer = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ output: [] }));
    const auth = {
      method: "oauth" as const,
      bearerToken: "PRIVATE_TOKEN",
      canRefresh: false,
    };
    const endpoint = getCodexEndpointConfig(auth, "PRIVATE_SESSION", {
      AGENTLINK_CODEX_ORIGINATOR: "diagnostic-client",
      AGENTLINK_CODEX_USER_AGENT: "diagnostic-client/7.8.9",
    });
    const client = createOpenAiResponsesClient(auth, endpoint, {
      fetch: createCodexIdentityDiagnosticFetch(fetch, observer),
    });
    await client.responses.create(
      { model: "gpt-6.1-sol", input: "PRIVATE_BODY" },
      {
        headers: { ...headers, originator: "request-override" },
      },
    );
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      transport: "http",
      ...expected,
      originator: "request-override",
    });
    expect(JSON.stringify(observer.mock.calls)).not.toContain("PRIVATE_");
  });

  it("preserves connector receiver, handshake request and result", async () => {
    const connection = {
      headers: new Headers(),
      isOpen: true,
      close() {},
      async *dispatch() {},
    };
    const connector = { connect: vi.fn().mockResolvedValue(connection) };
    const observer = vi.fn();
    const request = {
      url: "wss://example.com/PRIVATE_PATH",
      headers,
      handshakeTimeoutMs: 15000,
    };
    const wrapped = createCodexIdentityDiagnosticConnector(connector, observer);
    expect(await wrapped.connect(request)).toBe(connection);
    expect(connector.connect.mock.calls[0][0]).toBe(request);
    expect(connector.connect.mock.contexts[0]).toBe(connector);
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      transport: "websocket",
      ...expected,
    });
    expect(JSON.stringify(observer.mock.calls)).not.toContain("PRIVATE_");
  });

  it("bounds public values and ignores throwing observers without retrying", async () => {
    const observer = vi.fn(() => {
      throw new Error("logger failed");
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response());
    await createCodexIdentityDiagnosticFetch(fetch, observer)(
      "https://example.com",
      {
        headers: { "User-Agent": "x".repeat(2000) },
      },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]).toEqual([
      {
        transport: "http",
        originator: null,
        userAgent: `${"x".repeat(512)}[truncated]`,
        version: null,
        openAIBeta: null,
        responsesLite: null,
      },
    ]);
    const connector = {
      connect: vi.fn().mockRejectedValue(new Error("connection failed")),
    };
    await expect(
      createCodexIdentityDiagnosticConnector(connector, observer).connect({
        url: "wss://example.com",
        headers,
        handshakeTimeoutMs: 15000,
      }),
    ).rejects.toThrow("connection failed");
    expect(connector.connect).toHaveBeenCalledOnce();
  });
});
