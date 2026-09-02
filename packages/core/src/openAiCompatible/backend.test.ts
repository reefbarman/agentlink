import { describe, expect, it, vi } from "vitest";

import {
  CoreModelBackendRegistry,
  type CoreModelStreamRequest,
} from "../modelRuntime.js";
import type { NormalizedOpenAiCompatibleConnection } from "./config.js";
import { OpenAiCompatibleBackend } from "./backend.js";
import { OpenAiCompatibleRequestError } from "./errors.js";

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
          capabilities: models[0]!.capabilities,
        },
      },
    },
    ...overrides,
  };
}

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const requestContext = { principal, authContext: undefined };

function request(): CoreModelStreamRequest {
  return {
    model: "local-model",
    systemPrompt: "system",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 128,
  };
}

function response(): Response {
  return new Response(
    'data: {"id":"response","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAiCompatibleBackend", () => {
  it("implements the core backend catalog and capability contract", () => {
    const backend = new OpenAiCompatibleBackend({ connection: connection() });

    expect(backend.providerId).toBe("openai-compatible:test");
    expect(backend.getCapabilities("local-model").contextWindow).toBe(32_768);
    expect(backend.listModels()).toEqual([
      expect.objectContaining({
        id: "local-model",
        providerId: "openai-compatible:test",
        providerDisplayName: "Test Connection",
        authenticated: false,
      }),
    ]);
  });

  it("resolves host credentials for every stream and complete request", async () => {
    const resolveCredential = vi
      .fn()
      .mockResolvedValueOnce({
        providerId: "openai-compatible:test",
        method: "apiKey",
        secret: "first",
      })
      .mockResolvedValueOnce({
        providerId: "openai-compatible:test",
        method: "apiKey",
        secret: "second",
      })
      .mockResolvedValueOnce({
        providerId: "openai-compatible:test",
        method: "apiKey",
        secret: "catalog",
      });
    const authorizations: string[] = [];
    const backend = new OpenAiCompatibleBackend({
      connection: connection(),
      credentialResolver: { resolveCredential },
      credentialPrincipal: principal,
      fetch: async (_input, init) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return response();
      },
    });

    const events = [];
    for await (const event of backend.stream(request(), requestContext)) {
      events.push(event);
    }
    expect((await backend.complete(request(), requestContext)).text).toBe("ok");
    expect(authorizations).toEqual(["Bearer first", "Bearer second"]);
    expect(resolveCredential).toHaveBeenNthCalledWith(1, {
      principal,
      providerId: "openai-compatible:test",
      modelId: "local-model",
      purpose: "stream",
    });
    expect(resolveCredential).toHaveBeenNthCalledWith(2, {
      principal,
      providerId: "openai-compatible:test",
      modelId: "local-model",
      purpose: "complete",
    });
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
    const registry = new CoreModelBackendRegistry();
    registry.register(backend);
    await expect(
      registry.listCatalog({
        ...requestContext,
        ownerId: "test-owner",
        now: 123,
      }),
    ).resolves.toMatchObject({
      models: [expect.objectContaining({ authenticated: true })],
    });
    expect(resolveCredential).toHaveBeenNthCalledWith(3, {
      principal,
      providerId: "openai-compatible:test",
      modelId: "local-model",
      purpose: "authStatus",
    });
  });

  it("prefers request credentials and isolates constructor credentials by principal", async () => {
    const constructorResolver = vi.fn(async () => ({
      providerId: "openai-compatible:test",
      method: "apiKey" as const,
      secret: "constructor",
    }));
    const requestResolver = vi.fn(async () => ({
      providerId: "openai-compatible:test",
      method: "apiKey" as const,
      secret: "request",
    }));
    const authorizations: string[] = [];
    const backend = new OpenAiCompatibleBackend({
      connection: connection(),
      credentialResolver: { resolveCredential: constructorResolver },
      credentialPrincipal: principal,
      fetch: async (_input, init) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return response();
      },
    });

    await backend.complete(request(), {
      principal,
      authContext: {
        credentialResolver: { resolveCredential: requestResolver },
      },
    });
    expect(authorizations).toEqual(["Bearer request"]);
    expect(requestResolver).toHaveBeenCalledWith(
      expect.objectContaining({ principal }),
    );
    expect(constructorResolver).not.toHaveBeenCalled();

    await expect(
      backend.complete(request(), {
        principal: { tenantId: "other", subjectId: "subject" },
        authContext: undefined,
      }),
    ).rejects.toBeInstanceOf(OpenAiCompatibleRequestError);
    expect(constructorResolver).not.toHaveBeenCalled();
  });

  it("requires constructor credentials to bind to one principal", () => {
    expect(
      () =>
        new OpenAiCompatibleBackend({
          connection: connection(),
          credentialResolver: { resolveCredential: vi.fn() },
        }),
    ).toThrow(
      "OpenAI-compatible constructor credentials require a bound principal",
    );
  });

  it("supports no-auth connections and rejects missing required credentials", async () => {
    const base = connection();
    const noAuth = new OpenAiCompatibleBackend({
      connection: {
        ...base,
        authKey: undefined,
        runtimeProfile: { ...base.runtimeProfile, authRequired: false },
      },
      fetch: async () => response(),
    });
    await expect(
      noAuth.complete(request(), requestContext),
    ).resolves.toMatchObject({
      text: "ok",
    });
    await expect(noAuth.listAvailableModels(requestContext)).resolves.toEqual([
      expect.objectContaining({ authenticated: true }),
    ]);

    const required = new OpenAiCompatibleBackend({ connection: base });
    await expect(
      required.complete(request(), requestContext),
    ).rejects.toBeInstanceOf(OpenAiCompatibleRequestError);
    const registry = new CoreModelBackendRegistry();
    registry.register(required);
    await expect(
      registry.listCatalog({
        ...requestContext,
        ownerId: "test-owner",
        now: 123,
      }),
    ).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          authenticated: false,
          readiness: {
            status: "unavailable",
            reason: "OpenAI-compatible credential resolver is unavailable",
          },
        }),
      ],
    });
  });
});
