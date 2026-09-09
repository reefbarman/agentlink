import {
  createCodexProvider,
  createOpenAIProvider,
} from "./providerFactory.js";
import { describe, expect, it, vi } from "vitest";

import type { CodexFetch } from "./openaiClient.js";
import type { CoreModelCredentialResolver } from "../modelRuntime.js";
import { createAgentClient } from "../client.js";
import { z } from "zod";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };

function responsesSse(
  text: string,
  options: { status?: string } = {},
): Response {
  const output = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ];
  const events = [
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: {
        id: "response-1",
        status: options.status ?? "completed",
        output,
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("standalone Responses provider factories", () => {
  it("uses the public OpenAI endpoint, exact model, API-key resolver, and text.format schema", async () => {
    let request: Request | undefined;
    const fetch = vi.fn<CodexFetch>(async (input, init) => {
      request = new Request(input, init);
      return responsesSse('{"suggestions":["One"]}');
    });
    const provider = createOpenAIProvider({
      apiKey: ({ principal: current }) => `key-${current.subjectId}`,
      modelIds: ["gpt-5.4-mini"],
      fetch,
    });
    const client = createAgentClient({
      providers: [provider],
      defaultModel: { providerId: "openai", modelId: "gpt-5.4-mini" },
      createRequestId: () => "request-openai",
    });

    const result = await client.generateObject({
      principal,
      prompt: "Suggest a title",
      schemaName: "suggestions",
      schema: z.object({ suggestions: z.array(z.string()).min(1) }),
      maxOutputTokens: 512,
    });

    expect(result).toMatchObject({
      object: { suggestions: ["One"] },
      outputMode: "native",
      finishReason: "end_turn",
      terminationEvidence: "observed",
      attempts: 1,
      effectiveModel: "gpt-5.4-mini",
    });
    expect(request?.url).toBe("https://api.openai.com/v1/responses");
    expect(request?.headers.get("authorization")).toBe("Bearer key-subject-a");
    await expect(request?.json()).resolves.toMatchObject({
      model: "gpt-5.4-mini",
      store: false,
      max_output_tokens: 512,
      text: {
        format: {
          type: "json_schema",
          name: "suggestions",
          schema: { type: "object" },
          strict: false,
        },
      },
    });
  });

  it("keeps Codex OAuth request state isolated and omits unsupported output controls", async () => {
    const credentialRequests: Array<{
      principal: typeof principal;
      modelId: string;
    }> = [];
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn<CodexFetch>(async (input, init) => {
      const request = new Request(input, init);
      body = await request.json();
      expect(request.url).toBe(
        "https://chatgpt.com/backend-api/codex/responses",
      );
      expect(request.headers.get("authorization")).toBe("Bearer oauth-token");
      return responsesSse("hello");
    });
    const provider = createCodexProvider({
      modelIds: ["gpt-5.5"],
      credentialProvider: {
        async resolveAuth({ context, modelId }) {
          credentialRequests.push({ principal: context.principal, modelId });
          return {
            method: "oauth",
            bearerToken: "oauth-token",
            accountId: "account-a",
            oauthAccountPoolId: "pool-a",
            canRefresh: false,
          };
        },
      },
      fetch,
    });
    const client = createAgentClient({
      providers: [provider],
      defaultModel: { providerId: "codex", modelId: "gpt-5.5" },
    });

    await expect(
      client.generateText({ principal, prompt: "Hello" }),
    ).resolves.toMatchObject({
      text: "hello",
      terminationEvidence: "observed",
      attempts: 1,
    });
    expect(credentialRequests).toEqual([{ principal, modelId: "gpt-5.5" }]);
    expect(body).toMatchObject({ model: "gpt-5.5", store: false });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("previous_response_id");
  });

  it("honours operation credential precedence without falling back to factory credentials", async () => {
    const factoryCredential = vi.fn(async () => "factory-key");
    const operationCredential = vi.fn<
      CoreModelCredentialResolver["resolveCredential"]
    >(async () => null);
    const fetch = vi.fn<CodexFetch>();
    const provider = createOpenAIProvider({
      apiKey: factoryCredential,
      modelIds: ["gpt-5.4-mini"],
      fetch,
    });
    const client = createAgentClient({
      providers: [provider],
      defaultModel: { providerId: "openai", modelId: "gpt-5.4-mini" },
    });

    await expect(
      client.generateText({
        principal,
        prompt: "Hello",
        authContext: {
          credentialResolver: { resolveCredential: operationCredential },
        },
      }),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(operationCredential).toHaveBeenCalledOnce();
    expect(factoryCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects operation model-auth leases without falling back to factory credentials", async () => {
    const factoryCredential = vi.fn(async () => "factory-key");
    const fetch = vi.fn<CodexFetch>();
    const provider = createOpenAIProvider({
      apiKey: factoryCredential,
      modelIds: ["gpt-5.4-mini"],
      fetch,
    });
    const client = createAgentClient({
      providers: [provider],
      defaultModel: { providerId: "openai", modelId: "gpt-5.4-mini" },
    });

    await expect(
      client.generateText({
        principal,
        prompt: "Hello",
        authContext: {
          authProvider: {
            requestLease: async () => null,
            revokeLease: async () => undefined,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(factoryCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the client attempt-budget error before a retry dispatch", async () => {
    const fetch = vi.fn<CodexFetch>(
      async () => new Response("unavailable", { status: 503 }),
    );
    const provider = createOpenAIProvider({
      apiKey: "key",
      modelIds: ["gpt-5.4-mini"],
      fetch,
    });
    const client = createAgentClient({
      providers: [provider],
      defaultModel: { providerId: "openai", modelId: "gpt-5.4-mini" },
      createRequestId: () => "request-budget",
    });

    await expect(
      client.generateText({ principal, prompt: "Hello", maxRetries: 0 }),
    ).rejects.toMatchObject({
      name: "AgentClientError",
      code: "provider_unavailable",
      requestId: "request-budget",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("shares the physical attempt allowance with OAuth refresh redispatch", async () => {
    const createClient = (maxRetries: number) => {
      let token = "expired-token";
      const refreshAuth = vi.fn(async () => {
        token = "fresh-token";
        return {
          method: "oauth" as const,
          bearerToken: token,
          accountId: "account-a",
          oauthAccountPoolId: "pool-a",
          canRefresh: true,
        };
      });
      const fetch = vi.fn<CodexFetch>(async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        return authorization === "Bearer fresh-token"
          ? responsesSse("refreshed")
          : new Response("unauthorized", { status: 401 });
      });
      const provider = createCodexProvider({
        modelIds: ["gpt-5.5"],
        credentialProvider: {
          resolveAuth: async () => ({
            method: "oauth",
            bearerToken: token,
            accountId: "account-a",
            oauthAccountPoolId: "pool-a",
            canRefresh: true,
          }),
          refreshAuth,
        },
        fetch,
      });
      return {
        client: createAgentClient({
          providers: [provider],
          defaultModel: { providerId: "codex", modelId: "gpt-5.5" },
        }),
        fetch,
        refreshAuth,
        maxRetries,
      };
    };

    const blocked = createClient(0);
    await expect(
      blocked.client.generateText({
        principal,
        prompt: "Hello",
        maxRetries: blocked.maxRetries,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(blocked.refreshAuth).not.toHaveBeenCalled();
    expect(blocked.fetch).toHaveBeenCalledOnce();

    const allowed = createClient(1);
    await expect(
      allowed.client.generateText({
        principal,
        prompt: "Hello",
        maxRetries: allowed.maxRetries,
      }),
    ).resolves.toMatchObject({ text: "refreshed", attempts: 2 });
    expect(allowed.refreshAuth).toHaveBeenCalledOnce();
    expect(allowed.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails unsupported Codex structured output and explicit token caps before dispatch", async () => {
    const fetch = vi.fn<CodexFetch>();
    const provider = createCodexProvider({
      modelIds: ["gpt-5.5"],
      credentialProvider: {
        resolveAuth: async () => ({
          method: "oauth",
          bearerToken: "oauth-token",
          canRefresh: false,
        }),
      },
      fetch,
    });
    const client = createAgentClient({
      providers: [provider],
      defaultModel: { providerId: "codex", modelId: "gpt-5.5" },
    });

    await expect(
      client.generateObject({
        principal,
        prompt: "Return JSON",
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      client.generateText({
        principal,
        prompt: "Hello",
        maxOutputTokens: 512,
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
