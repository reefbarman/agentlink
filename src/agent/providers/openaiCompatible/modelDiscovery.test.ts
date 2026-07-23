import {
  OpenAiCompatibleAbortError,
  OpenAiCompatibleRequestError,
  OpenAiCompatibleTimeoutError,
} from "../../../core/model/providers/openaiCompatible/errors.js";
import { describe, expect, it, vi } from "vitest";

import { discoverOpenAiCompatibleModels } from "./modelDiscovery.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("discoverOpenAiCompatibleModels", () => {
  it("maps bounded OpenRouter metadata and sends the expected request", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          data: [
            {
              id: "moonshotai/kimi-k3",
              name: "MoonshotAI: Kimi K3",
              context_length: 1_048_576,
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              top_provider: {
                context_length: 900_000,
                max_completion_tokens: 65_536,
              },
              supported_parameters: [
                "tools",
                "tool_choice",
                "reasoning",
                "reasoning_effort",
              ],
              reasoning: {
                supported_efforts: ["max", "high", "low", "unknown", "high"],
                default_effort: "max",
              },
            },
          ],
        }),
    );

    const models = await discoverOpenAiCompatibleModels({
      baseUrl: "https://openrouter.ai/api/v1/",
      profile: "openrouter",
      apiKey: " secret-value ",
      fetch,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer secret-value");
    expect(headers.get("x-openrouter-title")).toBe("AgentLink");
    expect(headers.get("x-openrouter-categories")).toBe("ide-extension");
    expect(models).toEqual([
      {
        model: "moonshotai/kimi-k3",
        displayName: "MoonshotAI: Kimi K3",
        contextWindow: 900_000,
        maxOutputTokens: 65_536,
        supportsToolUse: true,
        supportsThinking: true,
        supportsImages: true,
        reasoningEfforts: ["max", "high", "low"],
        defaultReasoningEffort: "max",
        provenance: {
          displayName: "discovered",
          contextWindow: "discovered",
          maxOutputTokens: "discovered",
          supportsToolUse: "discovered",
          supportsThinking: "discovered",
          supportsImages: "discovered",
          reasoningEfforts: "discovered",
          defaultReasoningEffort: "discovered",
        },
      },
    ]);
  });

  it("uses conservative defaults for incomplete OpenRouter metadata", async () => {
    const models = await discoverOpenAiCompatibleModels({
      baseUrl: "https://openrouter.ai/api/v1",
      profile: "openrouter",
      fetch: async () =>
        jsonResponse({
          data: [
            {
              id: "moonshotai/kimi-k3",
              context_length: 1_048_576,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
              top_provider: { max_completion_tokens: null },
              supported_parameters: ["tools", "reasoning_effort"],
            },
          ],
        }),
    });

    expect(models[0]).toMatchObject({
      displayName: "moonshotai/kimi-k3",
      contextWindow: 1_048_576,
      maxOutputTokens: 4_096,
      supportsToolUse: false,
      supportsThinking: false,
      supportsImages: false,
      provenance: {
        displayName: "default",
        contextWindow: "discovered",
        maxOutputTokens: "default",
        supportsToolUse: "discovered",
        supportsThinking: "default",
        supportsImages: "discovered",
      },
    });
    expect(models[0]).not.toHaveProperty("reasoningEfforts");
  });

  it("maps generic IDs and numeric hints without inferring capabilities", async () => {
    const models = await discoverOpenAiCompatibleModels({
      baseUrl: "http://127.0.0.1:1234/v1",
      profile: "generic",
      fetch: async () =>
        jsonResponse({
          data: [
            {
              id: "loaded-model",
              name: "Loaded model",
              context_length: 16_384,
              max_completion_tokens: 2_048,
              supported_parameters: ["tools", "reasoning"],
              architecture: { input_modalities: ["image"] },
            },
            { id: "fallback-model" },
          ],
        }),
    });

    expect(models).toEqual([
      {
        model: "loaded-model",
        displayName: "Loaded model",
        contextWindow: 16_384,
        maxOutputTokens: 2_048,
        supportsToolUse: false,
        supportsThinking: false,
        supportsImages: false,
        provenance: {
          displayName: "discovered",
          contextWindow: "discovered",
          maxOutputTokens: "discovered",
          supportsToolUse: "default",
          supportsThinking: "default",
          supportsImages: "default",
        },
      },
      {
        model: "fallback-model",
        displayName: "fallback-model",
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        supportsToolUse: false,
        supportsThinking: false,
        supportsImages: false,
        provenance: {
          displayName: "default",
          contextWindow: "default",
          maxOutputTokens: "default",
          supportsToolUse: "default",
          supportsThinking: "default",
          supportsImages: "default",
        },
      },
    ]);
  });

  it("discards unusable, duplicate, and non-text-output catalog entries", async () => {
    const models = await discoverOpenAiCompatibleModels({
      baseUrl: "https://openrouter.ai/api/v1",
      profile: "openrouter",
      fetch: async () =>
        jsonResponse({
          data: [
            null,
            { id: "" },
            { id: "model-a", architecture: { output_modalities: ["image"] } },
            { id: "model-b" },
            { id: "model-b", name: "duplicate" },
          ],
        }),
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.model).toBe("model-b");
  });

  it("rejects structurally unsafe URLs before invoking fetch", async () => {
    const fetch = vi.fn();
    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://user:secret@example.invalid/v1",
        profile: "generic",
        fetch,
      }),
    ).rejects.toMatchObject({ providerCode: "invalid_base_url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects redirects without following them", async () => {
    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        apiKey: "secret-value",
        fetch: async () =>
          new Response(null, {
            status: 307,
            headers: { location: "https://other.example.invalid/models" },
          }),
      }),
    ).rejects.toMatchObject({
      status: 307,
      retryable: false,
      authentication: false,
    });
  });

  it("redacts credentials from bounded provider errors", async () => {
    const secret = "secret-value";
    let thrown: unknown;
    try {
      await discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        apiKey: secret,
        fetch: async () =>
          jsonResponse(
            {
              error: { message: `invalid ${secret}`, code: "invalid_api_key" },
            },
            { status: 401 },
          ),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenAiCompatibleRequestError);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(thrown).toMatchObject({ authentication: true, status: 401 });
  });

  it("enforces declared and streamed response body limits", async () => {
    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        maxBodyBytes: 10,
        fetch: async () =>
          new Response("{}", {
            headers: { "content-length": "11" },
          }),
      }),
    ).rejects.toMatchObject({ providerCode: "model_catalog_too_large" });

    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        maxBodyBytes: 10,
        fetch: async () => new Response('{"data":[{"id":"too-large"}]}'),
      }),
    ).rejects.toMatchObject({ providerCode: "model_catalog_too_large" });
  });

  it("enforces the usable model count without silently truncating", async () => {
    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        maxModels: 1,
        fetch: async () =>
          jsonResponse({ data: [{ id: "first" }, { id: "second" }] }),
      }),
    ).rejects.toMatchObject({ providerCode: "model_catalog_too_large" });
  });

  it.each([
    ["invalid JSON", new Response("not-json")],
    ["wrong root", jsonResponse([])],
    ["missing data", jsonResponse({ models: [] })],
    ["empty data", jsonResponse({ data: [] })],
  ])("rejects %s catalogs", async (_name, response) => {
    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        fetch: async () => response,
      }),
    ).rejects.toBeInstanceOf(OpenAiCompatibleRequestError);
  });

  it("distinguishes timeout from caller cancellation", async () => {
    const waitForAbort = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });

    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        timeoutMs: 5,
        fetch: waitForAbort,
      }),
    ).rejects.toBeInstanceOf(OpenAiCompatibleTimeoutError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverOpenAiCompatibleModels({
        baseUrl: "https://api.example.invalid/v1",
        profile: "generic",
        signal: controller.signal,
        fetch: waitForAbort,
      }),
    ).rejects.toBeInstanceOf(OpenAiCompatibleAbortError);
  });
});
