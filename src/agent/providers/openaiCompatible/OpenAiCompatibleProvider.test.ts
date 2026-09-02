import { describe, expect, it, vi } from "vitest";

import type { NormalizedOpenAiCompatibleConnection } from "@agentlink/core/openai-compatible";
import { OpenAiCompatibleProvider } from "./OpenAiCompatibleProvider.js";
import { collectOpenAiCompatibleCompletion } from "@agentlink/core/openai-compatible";
import { getOpenAiCompatibleSecretKey } from "../../openAiCompatibleSecrets.js";

function connection(
  overrides: Partial<NormalizedOpenAiCompatibleConnection> = {},
): NormalizedOpenAiCompatibleConnection {
  const models = [
    {
      id: "local-model",
      model: "wire/model-v1",
      displayName: "Local Model",
      capabilities: {
        supportsThinking: false,
        supportsCaching: false,
        supportsImages: false,
        supportsToolUse: true,
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
      },
    },
  ];
  return {
    id: "test",
    providerId: "openai-compatible:test",
    displayName: "Test Connection",
    baseUrl: "https://example.invalid/v1",
    profile: "generic",
    reasoningEffortMode: "none",
    authKey: "test-key",
    timeoutMs: 10_000,
    allowInsecureHttp: false,
    models,
    runtimeProfile: {
      providerId: "openai-compatible:test",
      baseUrl: "https://example.invalid/v1",
      profile: "generic",
      reasoningEffortMode: "none",
      timeoutMs: 10_000,
      authRequired: true,
      models: {
        "local-model": {
          id: "local-model",
          model: "wire/model-v1",
          capabilities: models[0].capabilities,
        },
      },
    },
    ...overrides,
  };
}

function request() {
  return {
    model: "local-model",
    systemPrompt: "system",
    messages: [{ role: "user" as const, content: "hello" }],
    maxTokens: 128,
  };
}

describe("OpenAiCompatibleProvider", () => {
  it("publishes connection-scoped model metadata and auxiliary selection", () => {
    const provider = new OpenAiCompatibleProvider({
      connection: connection(),
      secrets: { get: vi.fn().mockResolvedValue("secret") },
    });

    expect(provider.listModels()).toEqual([
      expect.objectContaining({
        id: "local-model",
        provider: "openai-compatible:test",
        providerDisplayName: "Test Connection",
        supportsToolUse: true,
        supportsImages: false,
      }),
    ]);
    expect(provider.getAuxiliaryModel("local-model")).toBe("local-model");
    expect(provider.getCapabilities("local-model").contextWindow).toBe(32_768);
  });

  it("exposes configured model family without changing provider identity", () => {
    const configured = connection({
      models: [
        {
          ...connection().models[0]!,
          modelFamily: "anthropic",
        },
      ],
    });
    const provider = new OpenAiCompatibleProvider({
      connection: configured,
      secrets: { get: vi.fn().mockResolvedValue("secret") },
    });

    expect(provider.id).toBe("openai-compatible:test");
    expect(provider.getModelFamily("local-model")).toBe("anthropic");
    expect(provider.getModelFamily("unknown")).toBeUndefined();
  });

  it("resolves the current secret for every request and sends the wire model", async () => {
    const secrets = {
      get: vi
        .fn()
        .mockResolvedValueOnce("first")
        .mockResolvedValueOnce("second"),
    };
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        expect(body.model).toBe("wire/model-v1");
        const authorization = new Headers(init?.headers).get("authorization");
        expect(["Bearer first", "Bearer second"]).toContain(authorization);
        return new Response(
          'data: {"id":"response","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    );
    const provider = new OpenAiCompatibleProvider({
      connection: connection(),
      secrets,
      fetch,
    });

    expect((await provider.complete(request())).text).toBe("ok");
    expect(
      (await collectOpenAiCompatibleCompletion(provider.stream(request())))
        .text,
    ).toBe("ok");
    expect(secrets.get).toHaveBeenCalledTimes(2);
    expect(secrets.get).toHaveBeenNthCalledWith(
      1,
      getOpenAiCompatibleSecretKey("test-key"),
    );
    expect(secrets.get).toHaveBeenNthCalledWith(
      2,
      getOpenAiCompatibleSecretKey("test-key"),
    );
  });

  it("checks authentication with the prefixed SecretStorage key", async () => {
    const secrets = { get: vi.fn().mockResolvedValue("secret") };
    const provider = new OpenAiCompatibleProvider({
      connection: connection(),
      secrets,
    });

    await expect(provider.isAuthenticated()).resolves.toBe(true);
    expect(secrets.get).toHaveBeenCalledWith(
      getOpenAiCompatibleSecretKey("test-key"),
    );
  });

  it("treats no-auth connections as authenticated without reading secrets", async () => {
    const secrets = { get: vi.fn() };
    const base = connection();
    const provider = new OpenAiCompatibleProvider({
      connection: {
        ...base,
        authKey: undefined,
        runtimeProfile: { ...base.runtimeProfile, authRequired: false },
      },
      secrets,
    });

    await expect(provider.isAuthenticated()).resolves.toBe(true);
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("uses the configured same-connection auxiliary model", () => {
    const provider = new OpenAiCompatibleProvider({
      connection: connection({ auxiliaryModel: "local-model" }),
      secrets: { get: vi.fn() },
    });
    expect(provider.getAuxiliaryModel("missing")).toBe("local-model");
  });
});
