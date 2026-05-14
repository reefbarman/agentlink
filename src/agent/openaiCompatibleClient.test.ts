import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceConfig: Record<string, unknown> = {};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(key: string, fallback: T): T => {
        return (workspaceConfig[key] as T | undefined) ?? fallback;
      },
    }),
  },
}));

import {
  callOpenAiCompatibleChat,
  getOpenAiCompatibleEndpoint,
} from "./openaiCompatibleClient";

function buildChatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getOpenAiCompatibleEndpoint", () => {
  beforeEach(() => {
    for (const key of Object.keys(workspaceConfig)) {
      delete workspaceConfig[key];
    }
  });

  it("returns defaults when nothing is set", () => {
    expect(getOpenAiCompatibleEndpoint()).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "",
      apiKey: "",
      timeoutMs: 5000,
    });
  });

  it("strips trailing slashes from baseUrl", () => {
    workspaceConfig["openaiCompatible.baseUrl"] = "http://example.com/v1///";
    expect(getOpenAiCompatibleEndpoint().baseUrl).toBe(
      "http://example.com/v1",
    );
  });

  it("trims whitespace on model and apiKey", () => {
    workspaceConfig["openaiCompatible.model"] = "  my-model  ";
    workspaceConfig["openaiCompatible.apiKey"] = "  sk-abc  ";
    const endpoint = getOpenAiCompatibleEndpoint();
    expect(endpoint.model).toBe("my-model");
    expect(endpoint.apiKey).toBe("sk-abc");
  });

  it("falls back to legacy questionDetection.* keys when new keys are unset", () => {
    workspaceConfig["questionDetection.baseUrl"] = "http://legacy.example/v1";
    workspaceConfig["questionDetection.model"] = "legacy-model";
    workspaceConfig["questionDetection.apiKey"] = "sk-legacy";
    workspaceConfig["questionDetection.timeoutMs"] = 9999;
    expect(getOpenAiCompatibleEndpoint()).toEqual({
      baseUrl: "http://legacy.example/v1",
      model: "legacy-model",
      apiKey: "sk-legacy",
      timeoutMs: 9999,
    });
  });

  it("new keys take precedence over legacy", () => {
    workspaceConfig["openaiCompatible.baseUrl"] = "http://new.example/v1";
    workspaceConfig["questionDetection.baseUrl"] = "http://legacy.example/v1";
    expect(getOpenAiCompatibleEndpoint().baseUrl).toBe(
      "http://new.example/v1",
    );
  });
});

describe("callOpenAiCompatibleChat", () => {
  const ENDPOINT = {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "test-model",
    apiKey: "",
    timeoutMs: 5000,
  };

  it("sends a correctly shaped POST and returns content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildChatResponse("hello"));
    const result = await callOpenAiCompatibleChat({
      endpoint: ENDPOINT,
      systemPrompt: "sys",
      userContent: "user",
      maxTokens: 50,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(50);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
    expect("response_format" in body).toBe(false);
    expect(result.content).toBe("hello");
  });

  it("includes json_schema when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildChatResponse('{"ok":1}'));
    await callOpenAiCompatibleChat({
      endpoint: ENDPOINT,
      systemPrompt: "sys",
      userContent: "user",
      jsonSchema: {
        name: "thing",
        strict: true,
        schema: { type: "object", additionalProperties: false },
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("thing");
  });

  it("omits model when endpoint.model is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildChatResponse("ok"));
    await callOpenAiCompatibleChat({
      endpoint: { ...ENDPOINT, model: "" },
      systemPrompt: "sys",
      userContent: "user",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect("model" in body).toBe(false);
  });

  it("sends Authorization header when apiKey is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildChatResponse("ok"));
    await callOpenAiCompatibleChat({
      endpoint: { ...ENDPOINT, apiKey: "sk-test" },
      systemPrompt: "sys",
      userContent: "user",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("throws on non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(
      callOpenAiCompatibleChat({
        endpoint: ENDPOINT,
        systemPrompt: "sys",
        userContent: "user",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/http 500/);
  });

  it("throws on empty response content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(buildChatResponse(""));
    await expect(
      callOpenAiCompatibleChat({
        endpoint: ENDPOINT,
        systemPrompt: "sys",
        userContent: "user",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("empty response");
  });
});
